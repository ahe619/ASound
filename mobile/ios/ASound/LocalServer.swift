// A very small read-only HTTP server for the files in the app bundle, on 127.0.0.1 only.
// GET and HEAD, no directory listings, nothing outside the www folder.
import Foundation
import Network

final class LocalServer: ObservableObject {
    @Published private(set) var url: URL?
    private let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "asound.localserver")

    init(root: URL) { self.root = root.standardizedFileURL }

    func start() {
        guard listener == nil else { return }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 8770)
        guard let l = try? NWListener(using: params) else { return }
        l.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        l.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = l.port?.rawValue {
                DispatchQueue.main.async { self?.url = URL(string: "http://localhost:\(port)/") }
            }
        }
        l.start(queue: queue)
        listener = l
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let head = String(data: data, encoding: .utf8) else { conn.cancel(); return }
            let parts = head.split(separator: "\r\n").first?.split(separator: " ") ?? []
            guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { self.send(conn, 405, "text/plain", Data()); return }
            var path = String(parts[1].split(separator: "?").first ?? "/").removingPercentEncoding ?? "/"
            if path.hasSuffix("/") { path += "index.html" }
            let file = self.root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
            guard file.path.hasPrefix(self.root.path), let body = try? Data(contentsOf: file) else {
                self.send(conn, 404, "text/plain", Data("not found".utf8))
                return
            }
            self.send(conn, 200, Self.type(of: file.pathExtension), parts[0] == "HEAD" ? Data() : body, length: body.count)
        }
    }

    private func send(_ conn: NWConnection, _ code: Int, _ type: String, _ body: Data, length: Int? = nil) {
        let reason = [200: "OK", 404: "Not Found", 405: "Method Not Allowed"][code] ?? "Error"
        var head = "HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(length ?? body.count)\r\n"
        head += "Cache-Control: no-cache\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
    }

    private static func type(of ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}
