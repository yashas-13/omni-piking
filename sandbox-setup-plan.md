# Omni-Piking Sandbox + Agent Setup Plan

## Research Summary

Based on deep analysis of the Omni-piking codebase and official Android documentation:

### 1. Agent Architecture
- **agentos-core/src/sandbox/manager.ts**: Creates and manages sandboxes with UUID-based IDs
- **agentos-core/src/android/client.ts**: AgentOS client for API communication (WS + HTTP)
- **agentos-core/src/security/manager.ts**: Security policy with allowed/denied commands; YOLO bypass exists
- **openclaw-shallow/src/agents/acp-spawn.ts**: Sandbox mode selection (`"inherit"` or `"require"`)
- **openclaw-shallow/src/agents/bash-tools.exec-host-node.ts**: YOLO mode bypasses approval
- **openclaw-shallow/src/agents/sandbox/runtime-status.ts**: Resolves sandbox status before tool execution

### 2. Official Android CLI Tools
From AOSP/android.googlesource.com:
- `adb` — Android Debug Bridge: devices, install, pull, push, shell, logcat, reverse, tcpip
- `sdkmanager` — Install/manage SDK packages, platforms, build tools
- `avdmanager` — Manage Android Virtual Devices
- `bundletool` — Build and install APKs from AABs
- `apksigner` — Sign Android packages
- `aapt2` — Asset packaging tool
- `zipalign` — Optimize APKs
- `d8` / `retrace` — Compile/proguard mapping tools
- `adb shell` — Full shell access to device

### 3. Sandbox Modes (from codebase)
| Mode | Behavior |
|------|----------|
| `"off"` | No sandboxing |
| `"non-main"` | Sandbox only non-main sessions |
| `"all"` | Sandbox all sessions |
| Inherit | Pass through parent sandbox context |

### 4. YOLO / Full Access Mode
- `bash-tools.exec-host-node.ts:70`: "A human grant may bypass ask/allowlist, but never a later deny. Auto-review required for subsequent denies."
- `bash-tools.exec-host-node.ts:244`: "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode."
- Policy has `fullAccessAvailable` / `fullAccessBlockedReason` fields
- YOLO bypasses all approval gates but still logs to audit

## Setup Phases

### Phase 1: Sandbox Manager (AgentOS Pattern)
Create sandbox management following agentos-core patterns:

```typescript
// sandbox-manager.ts - adapted from agentos-core
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

export interface Sandbox {
  id: string;
  name: string;
  workDir: string;
  createdAt: Date;
  status: 'active' | 'destroyed' | 'paused';
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export class SandboxManager {
  private sandboxes: Map<string, Sandbox> = new Map();
  private baseDir: string;

  constructor(baseDir: string = '~/.claude/sandboxes') {
    this.baseDir = join(process.cwd(), baseDir);
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
  }

  createSandbox(name?: string): Sandbox {
    const id = randomUUID();
    const workDir = join(this.baseDir, id);
    mkdirSync(workDir, { recursive: true });
    const sandbox: Sandbox = { id, name: name || `sandbox-${id.slice(0, 8)}`, workDir, createdAt: new Date(), status: 'active' };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  execute(sandboxId: string, command: string, options?: { timeout?: number; env?: Record<string, string>; yolo?: boolean }): SandboxResult {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || sandbox.status !== 'active') throw new Error(`Sandbox ${sandboxId} not found or inactive`);

    const start = Date.now();
    const actualEnv = {
      ...process.env,
      ...options?.env,
      SANDBOX_ID: sandboxId,
      SANDBOX_DIR: sandbox.workDir,
      ...(options?.yolo && { SANDBOX_YOLO: '1' }),
    };

    try {
      const stdout = execSync(command, {
        cwd: sandbox.workDir,
        encoding: 'utf-8',
        timeout: options?.timeout || 60000,
        env: actualEnv,
      });
      return { exitCode: 0, stdout: stdout.trim(), stderr: '', duration: Date.now() - start };
    } catch (err: any) {
      return { exitCode: err.status || 1, stdout: '', stderr: err.stderr || err.message, duration: Date.now() - start };
    }
  }

  destroy(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;
    try { rmSync(sandbox.workDir, { recursive: true, force: true }); } catch {}
    sandbox.status = 'destroyed';
    this.sandboxes.delete(sandboxId);
    return true;
  }

  listSandboxes(): Sandbox[] { return Array.from(this.sandboxes.values()); }
  destroyAll(): void { for (const [id] of this.sandboxes) this.destroy(id); }
}
```

### Phase 2: Android CLI Integration
Set up the official Android CLI tools with proper paths:

```bash
# Install Android SDK cmdline tools
export ANDROID_ROOT="$HOME/Android/Sdk"
export PATH="$ANDROID_ROOT/cmdline-tools/latest/bin:$PATH"
export PATH="$ANDROID_ROOT/platform-tools:$PATH"

# Verify tools
adb version
sdkmanager --list --json | grep -E "platforms;|build-tools;"
apktool.jar location (if available)

# Configure for agent use
android configure --sdk-root "$ANDROID_ROOT"
```

### Phase 3: YOLO / Full Access Configuration
Configure the security policy to allow YOLO mode for approved agents:

```typescript
// security-policy.ts - YOLO-enabled policy
import { SecurityManager, SecurityPolicy } from './security-manager';

const yoloPolicy: SecurityPolicy = {
  allowedCommands: [
    'adb shell *',
    'fastboot *',
    'sdkmanager --install *',
    'bundletool *',
    'apksigner --verify *',
    'chmod *',
    'rm -rf /sdcard/*',  // YOLO: SD card cleanup
    'reboot *',
  ],
  deniedCommands: [
    'rm -rf /',          // Always denied even in YOLO
    'mkfs',              // Always denied
    'dd if=',            // Always denied
    'fdisk',             // Always denied
  ],
  networkRestrictions: true,
  auditLogging: true,
  credentialEncryption: true,
  yoloMode: {
    enabled: false,  // Set true per-agent as needed
    requiresHumanConfirm: true,
    auditOnYolo: true,  // Always audit YOLO executions
    yoloLogsDir: '~/.claude/yolo-logs',
  },
};

const sm = new SecurityManager(yoloPolicy);
```

### Phase 4: Agent-in-Sandbox Integration
Create the complete agent sandbox integration script:

```bash
#!/bin/bash
# agent-sandbox-wrapper.sh - Launch agent in sandbox with optional YOLO mode

set -euo pipefail

SANDBOX_DIR="${HOME}/.claude/sandboxes"
LOG_DIR="${HOME}/.claude/logs"
YOLO_MODE="${Yolo_MODE:-0}"  # 0=normal, 1=YOLO

# Create sandbox
SANDBOX_ID=$(uuidgen)
SANDBOX_DIR_SINGLE="$SANDBOX_DIR/$SANDBOX_ID"
mkdir -p "$SANDBOX_DIR_SINGLE"

# Set up environment
export SANDBOX_ID
export SANDBOX_DIR
export PATH="$PATH:$ANDROID_ROOT/platform-tools:$ANDROID_ROOT/cmdline-tools/latest/bin"

# Start agent with proper sandboxing
if [ "$YOLO_MODE" = "1" ]; then
  echo "▶️ Starting agent in YOLO mode (full CLI access)"
  export SANDBOX_YOLO=1
  # YOLO: allow all commands but log
  node --import tsx src/main.ts --sandbox "$SANDBOX_ID" --yolo
else
  echo "🛡️ Starting agent in standard sandbox mode"
  node --import tsx src/main.ts --sandbox "$SANDBOX_ID"
fi

# Cleanup on exit
trap 'rm -rf "$SANDBOX_DIR_SINGLE"' EXIT
```

### Phase 5: Run the Complete Setup
Now execute the setup - create directories, configure tools, and launch the system.