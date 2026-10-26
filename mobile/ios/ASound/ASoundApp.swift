// ASound for iPhone and iPad: one WKWebView showing the bundled web app (the app/ folder, copied into the bundle as
// "www"). The files are served by a tiny server on http://localhost (LocalServer.swift): a secure context, so the
// page may use the microphone, WebGPU (iOS 26+) and its storage for the models it downloads.
import SwiftUI
import WebKit

@main
struct ASoundApp: App {
    @StateObject private var server = LocalServer(root: Bundle.main.resourceURL!.appendingPathComponent("www"))

    var body: some Scene {
        WindowGroup {
            Group {
                if let url = server.url {
                    WebView(url: url).ignoresSafeArea(.container, edges: .bottom)
                } else {
                    ProgressView()
                }
            }
            .background(Color(red: 0.04, green: 0.06, blue: 0.16))
            .onAppear { server.start() }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default() // keeps the downloaded models between launches
        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = context.coordinator
        web.navigationDelegate = context.coordinator
        web.isOpaque = false
        web.load(URLRequest(url: url.appendingPathComponent("index.html").appending(queryItems: [URLQueryItem(name: "app", value: "ios")])))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        // The page asks for the microphone; iOS shows its own prompt (NSMicrophoneUsageDescription) the first time.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == "localhost" && type == .microphone ? .grant : .deny)
        }

        // Links to other sites open in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = action.request.url, url.host != "localhost", action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
