import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { CurlEditAndResendProvider } from '../../src/extension';

// Mock the CurlEditAndResendProvider class for testing
function createMockContext(extensionUri: vscode.Uri): vscode.ExtensionContext {
  const noopMemento: vscode.Memento = {
    get: () => undefined,
    update: () => Promise.resolve(),
    keys: () => []
  };

  const mockEnvCollection: vscode.EnvironmentVariableCollection = {
    persistent: true,
    description: undefined,
    replace: () => {},
    append: () => {},
    prepend: () => {},
    get: () => undefined,
    forEach: () => {},
    delete: () => {},
    clear: () => {},
    [Symbol.iterator]: function* () { /* no-op iterator */ }
  };

  return {
    subscriptions: [],
    workspaceState: noopMemento,
    globalState: noopMemento,
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {}
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
    asAbsolutePath: (relativePath: string) => path.join(extensionUri.fsPath, relativePath),
    extension: {} as vscode.Extension<any>
  } as unknown as vscode.ExtensionContext;
}

class MockCurlEditAndResendProvider extends CurlEditAndResendProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context);
  }

  // Expose the private method for testing
  public getHtmlForWebviewTest(webview: vscode.Webview): string {
    return this._getHtmlForWebview(webview);
  }
}

suite('CurlEditAndResendProvider Tests', () => {
  let extensionUri: vscode.Uri;

  suiteSetup(() => {
    // Create a mock extension URI pointing to the project root
    extensionUri = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
  });

  test('_getHtmlForWebview should return valid HTML', () => {
    const context = createMockContext(extensionUri);
    const provider = new MockCurlEditAndResendProvider(context);

    // Mock webview object
    const mockWebview: vscode.Webview = {
      options: {},
      html: '',
      cspSource: 'data:'
    } as vscode.Webview;

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
    const mockWebviewView: vscode.WebviewView = {
      webview: {
        options: {},
        html: '',
        cspSource: 'data:'
      } as vscode.Webview,
      show: (_preserveFocus: boolean) => { /* mock show method */ }
    } as vscode.WebviewView;

    // Mock context and token
    const mockContext: vscode.WebviewViewResolveContext = {} as vscode.WebviewViewResolveContext;
    const mockToken: vscode.CancellationToken = {} as vscode.CancellationToken;

    provider.resolveWebviewView(mockWebviewView, mockContext, mockToken);

    // Assert that webview.html is set
    assert.ok(mockWebviewView.webview.html.length > 0, 'Webview HTML should be set');
    assert.ok(mockWebviewView.webview.html.includes('<!DOCTYPE html>'), 'Webview HTML should contain <!DOCTYPE html>');
  }).timeout(10000);
});
