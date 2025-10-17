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
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const extension_1 = require("../../src/extension");
// Mock the CurlEditAndResendProvider class for testing
function createMockContext(extensionUri) {
    const noopMemento = {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => []
    };
    const mockEnvCollection = {
        persistent: true,
        description: undefined,
        replace: () => { },
        append: () => { },
        prepend: () => { },
        get: () => undefined,
        forEach: () => { },
        delete: () => { },
        clear: () => { },
        [Symbol.iterator]: function* () { }
    };
    return {
        subscriptions: [],
        workspaceState: noopMemento,
        globalState: noopMemento,
        secrets: {
            get: () => __awaiter(this, void 0, void 0, function* () { return undefined; }),
            store: () => __awaiter(this, void 0, void 0, function* () { }),
            delete: () => __awaiter(this, void 0, void 0, function* () { })
        },
        extensionUri,
        extensionPath: extensionUri.fsPath,
        globalStorageUri: extensionUri,
        storageUri: extensionUri,
        logUri: extensionUri,
        logPath: extensionUri.fsPath,
        globalStoragePath: extensionUri.fsPath,
        storagePath: extensionUri.fsPath,
        extensionMode: vscode.ExtensionMode.Test,
        environmentVariableCollection: mockEnvCollection,
        asAbsolutePath: (relativePath) => path.join(extensionUri.fsPath, relativePath),
        extension: {}
    };
}
class MockCurlEditAndResendProvider extends extension_1.CurlEditAndResendProvider {
    constructor(context) {
        super(context);
    }
    // Expose the private method for testing
    getHtmlForWebviewTest(webview) {
        return this._getHtmlForWebview(webview);
    }
}
suite('CurlEditAndResendProvider Tests', () => {
    let extensionUri;
    suiteSetup(() => {
        // Create a mock extension URI pointing to the project root
        extensionUri = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
    });
    test('_getHtmlForWebview should return valid HTML', () => {
        const context = createMockContext(extensionUri);
        const provider = new MockCurlEditAndResendProvider(context);
        // Mock webview object
        const mockWebview = {
            options: {},
            html: '',
            cspSource: 'data:'
        };
        const htmlContent = provider.getHtmlForWebviewTest(mockWebview);
        // Assert that the HTML content is not empty and contains basic HTML tags
        assert.ok(htmlContent.length > 0, 'HTML content should not be empty');
        assert.ok(htmlContent.includes('<!DOCTYPE html>'), 'HTML content should contain <!DOCTYPE html>');
        assert.ok(htmlContent.includes('<html'), 'HTML content should contain <html> tag');
        assert.ok(htmlContent.includes('<body'), 'HTML content should contain <body> tag');
    }).timeout(10000);
    test('resolveWebviewView should set webview HTML', () => {
        const context = createMockContext(extensionUri);
        const provider = new MockCurlEditAndResendProvider(context);
        // Mock WebviewView object
        const mockWebviewView = {
            webview: {
                options: {},
                html: '',
                cspSource: 'data:'
            },
            show: (_preserveFocus) => { }
        };
        // Mock context and token
        const mockContext = {};
        const mockToken = {};
        provider.resolveWebviewView(mockWebviewView, mockContext, mockToken);
        // Assert that webview.html is set
        assert.ok(mockWebviewView.webview.html.length > 0, 'Webview HTML should be set');
        assert.ok(mockWebviewView.webview.html.includes('<!DOCTYPE html>'), 'Webview HTML should contain <!DOCTYPE html>');
    }).timeout(10000);
});
//# sourceMappingURL=extension.test.js.map