import CommonCrypto
import Foundation

/// Password → storage key for protected recordings. The key names the folder
/// (`reel/v/<id>/k/<key>/`) that holds the recording; it is never written remotely, listing is
/// denied by the rules, so the only way to find the files is to know the password (each guess
/// costs one network request). The viewer derives the same key with WebCrypto:
/// PBKDF2-HMAC-SHA256(password UTF-8, salt bytes, 210 000 iterations) → 16 bytes → lowercase hex.
public enum AccessKey {
    public static let iterations = 210_000
    public static let keyBytes = 16
    public static let saltBytes = 16

    public static func newSalt() -> String {
        var g = SystemRandomNumberGenerator()
        return hex((0..<saltBytes).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    public static func derive(password: String, saltHex: String, iterations: Int = iterations, length: Int = keyBytes) -> String? {
        guard !password.isEmpty, let salt = bytes(fromHex: saltHex) else { return nil }
        var out = [UInt8](repeating: 0, count: length)
        let pw = Array(password.utf8)
        let status = pw.withUnsafeBufferPointer { p in
            salt.withUnsafeBufferPointer { s in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                     p.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) }, pw.count,
                                     s.baseAddress, salt.count,
                                     CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                     &out, length)
            }
        }
        return status == kCCSuccess ? hex(out) : nil
    }

    public static func isValidKey(_ key: String) -> Bool {
        key.count == keyBytes * 2 && key.allSatisfy { "0123456789abcdef".contains($0) }
    }

    /// Minimum password length enforced by the app (the rules can't see passwords).
    public static let minimumPasswordLength = 4

    public static func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

    public static func bytes(fromHex s: String) -> [UInt8]? {
        guard s.count % 2 == 0, !s.isEmpty else { return nil }
        var out: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }
}
