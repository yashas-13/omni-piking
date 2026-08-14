# Android CLI + Sandbox + Agent Research (Official Sources)

## 1. Official Android CLI Tools (from AOSP / developer.android.com)

| Tool | Location | Purpose |
|------|----------|---------|
| `adb` | platform-tools | Android Debug Bridge: `devices`, `install`, `push`, `pull`, `shell`, `logcat`, `reverse`, `tcpip`, `wireless` |
| `fastboot` | platform-tools | Bootloader flash / unlock |
| `sdkmanager` | cmdline-tools/latest/bin | Install/update SDK packages, platforms, build-tools |
| `avdmanager` | cmdline-tools/latest/bin | Create/manage AVDs (emulators) |
| `apksigner` | build-tools/34.0.0 | Sign & verify APKs |
| `aapt2` | build-tools/34.0.0 | Asset packaging |
| `zipalign` | build-tools/34.0.0 | APK optimization |
| `d8` | build-tools/34.0.0 | DEX compiler |
| `retrace` | cmdline-tools/latest/bin | ProGuard mapping deobfuscation |
| `bundletool` | external jar | Build/install APKs from AAB |
| `apkanalyzer` | cmdline-tools/latest/bin | Inspect APK/AAB structure |

### Key Commands (from developer.android.com/tools)
```
adb devices -l                    # List devices with details
adb install -r app.apk            # Install/reinstall
adb shell <command>               # Run shell on device
adb push <local> <remote>         # Copy to device
adb pull <remote> <local>         # Copy from device
adb logcat                       # View system logs
adb reverse tcp:8080 tcp:8080    # Reverse port forward
adb tcpip 5555                   # Switch to wireless
sdkmanager "platforms;android-34" "build-tools;34.0.0"
avdmanager create avd -n test -k "system-images;android-34;default;arm64-v8a"
apksigner sign --ks keystore.jks app.apk
zipalign -f 4 in.apk out.apk
```

## 2. Omni-Piking Agent Architecture (from codebase)

### Sandbox (agentos-core/src/sandbox/manager.ts)
- UUID-based sandbox creation
- Per-sandbox work directory
- `execute(command, {timeout, env, yolo})` → SandboxResult
- `destroy()` removes work dir

### Security Policy (agentos-core/src/security/manager.ts)
```typescript
interface SecurityPolicy {
  allowedCommands: string[];
  deniedCommands: string[];      // ["rm -rf /", "mkfs", "dd if="]
  networkRestrictions: boolean;
  auditLogging: boolean;
  credentialEncryption: boolean;
}
```
- `isCommandAllowed()` checks denied first, then allowed
- `auditLog()` always logs even in YOLO

### Sandbox Modes (openclaw-shallow/src/agents/acp-spawn.ts)
| Mode | Behavior |
|------|----------|
| `off` | No sandboxing |
| `non-main` | Sandbox only non-main sessions |
| `all` | Sandbox all sessions |
| `inherit` | Pass through parent context |

### YOLO / Full Access (openclaw-shallow/src/agents/bash-tools.exec-host-node.ts)
- `fullAccessAvailable`, `fullAccessBlockedReason` fields in policy
- "A human grant may bypass ask/allowlist, but never a later deny"
- "security audit suppression changes require explicit approval unless exec is running in yolo mode"
- YOLO bypasses approval gates but still writes to audit log

### Tool Policy (openclaw-shallow/src/agents/sandbox/tool-policy.ts)
- `allow`, `alsoAllow`, `deny` lists
- Sources: `agent`, `global`, `default`
- Glob pattern matching for tool names

## 3. Implementation

### Files Created
- `sandbox-agent-setup.ts` — Full TypeScript implementation
- `sandbox-agent.sh` — Bash launcher with YOLO toggle
- `tools/bundletool.jar` — (download pending)
- `sandbox-setup-plan.md` — Design notes

### Setup Steps Completed
1. ✅ Installed Android SDK cmdline-tools (sdkmanager v12.0)
2. ✅ Installed platform-tools (adb 1.0.41, fastboot)
3. ✅ Installed platforms;android-34 + build-tools;34.0.0 (apksigner, aapt2, zipalign, d8)
4. ✅ Accepted all SDK licenses
5. ✅ Configured PATH in ~/.bashrc
6. ✅ Created ~/.claude/sandboxes and ~/.claude/yolo-logs
7. ✅ Implemented SandboxManager, SecurityManager, AndroidCli, AgentSandboxLauncher

### Usage
```bash
# Standard agent in sandbox
./sandbox-agent.sh -a omniking

# YOLO full-access agent
./sandbox-agent.sh -a omniking --yolo

# From TS:
import { createOmniPikingSandboxSystem } from './sandbox-agent-setup';
const { sandbox, security, android, launcher } = createOmniPikingSandboxSystem();
const sb = sandbox.createSandbox('demo');
android.devices(sb.id);   // adb devices
```

## 4. Security Notes
- YOLO mode always logs to `~/.claude/yolo-logs/audit.log`
- Denied commands (`rm -rf /`, `mkfs`, `dd if=`, `fdisk`, `reboot`, `shutdown`) are hard-blocked even in YOLO
- Sandboxes are isolated by UUID work directories
- Credentials encrypted via SecurityManager

## 5. Next Steps
- [ ] Download bundletool.jar (official) into tools/
- [ ] Add Docker/container backend option for stronger isolation
- [ ] Wire into agentos-core main.ts dashboard
- [ ] Add AVD emulator creation for CI testing
- [ ] Integrate 9Router Kingdom gateway (port 20128) for multi-agent routing
