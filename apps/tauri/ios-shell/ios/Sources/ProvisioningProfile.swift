import Foundation

/// The `aps-environment` of the profile embedded in the app. App Store and TestFlight builds carry
/// no embedded profile; the Rust side reads that absence as production.
enum ProvisioningProfile {
  static func apsEnvironment(_ bundle: Bundle = .main) -> String? {
    guard
      let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
      let signed = try? Data(contentsOf: url),
      let plist = propertyList(inside: signed),
      let entitlements = plist["Entitlements"] as? [String: Any]
    else { return nil }
    return entitlements["aps-environment"] as? String
  }

  /// The profile is a CMS envelope around an XML property list; Apple offers no public API to
  /// open it on iOS, so the plist is cut out of the signed bytes.
  private static func propertyList(inside signed: Data) -> [String: Any]? {
    guard
      let start = signed.range(of: Data("<?xml".utf8)),
      let end = signed.range(of: Data("</plist>".utf8), in: start.lowerBound..<signed.endIndex)
    else { return nil }
    let xml = signed.subdata(in: start.lowerBound..<end.upperBound)
    return try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any]
  }
}
