import Foundation
import Security

private struct Request: Decodable {
    let operation: String
    let origin: String
    let username: String
    let token: String?
}

private struct Reply: Encodable {
    let ok: Bool
    var token: String? = nil
}

private func perform(_ request: Request) -> Reply {
    guard !request.origin.isEmpty, !request.username.isEmpty else { return Reply(ok: false) }
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: "dev.peerpedia.obsidian.token/" + request.origin,
        kSecAttrAccount: request.username,
        kSecAttrSynchronizable: false,
    ]
    switch request.operation {
    case "read":
        var lookup = query
        lookup[kSecReturnData] = true
        lookup[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return Reply(ok: true) }
        guard status == errSecSuccess, let data = item as? Data,
              let token = String(data: data, encoding: .utf8) else { return Reply(ok: false) }
        return Reply(ok: true, token: token)
    case "write":
        guard let token = request.token, !token.isEmpty else { return Reply(ok: false) }
        let value: [CFString: Any] = [kSecValueData: Data(token.utf8)]
        var status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            var entry = query
            entry[kSecValueData] = value[kSecValueData]
            status = SecItemAdd(entry as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
            }
        }
        return Reply(ok: status == errSecSuccess)
    case "remove":
        let status = SecItemDelete(query as CFDictionary)
        return Reply(ok: status == errSecSuccess || status == errSecItemNotFound)
    default:
        return Reply(ok: false)
    }
}

private func run() -> Void {
    SecKeychainSetUserInteractionAllowed(false)
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let reply: Reply
    if let request = try? JSONDecoder().decode(Request.self, from: input) {
        reply = perform(request)
    } else {
        reply = Reply(ok: false)
    }
    if let data = try? JSONEncoder().encode(reply) {
        FileHandle.standardOutput.write(data)
    }
}

run()
