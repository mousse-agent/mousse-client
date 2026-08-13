# Remaining gaps

- The MMS server hardening pass must publish and capability-advertise the canonical project-scoped `files.*` and `git.*` RPC methods. The client now sends `projectId` for each such call, but the current server checkout does not yet expose those methods over HTTP.
- The current MMS handler implements `agents.spawn`, but its `PROTOCOL_METHODS` allowlist does not advertise it. The server pass should add it before remote agent creation can work end-to-end.
- iOS native compilation was not run on this Windows environment because CocoaPods and Xcode are unavailable. Capacitor sync completed; Android debug compilation completed with JDK 21.
