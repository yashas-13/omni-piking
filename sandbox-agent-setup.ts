/**
 * Omni-Piking Sandbox + Agent Setup
 *
 * Based on:
 *  - agentos-core/src/sandbox/manager.ts (UUID-based sandbox lifecycle)
 *  - agentos-core/src/security/manager.ts (YOLO policy)
 *  - openclaw-shallow/src/agents/acp-spawn.ts (sandbox mode inheritance)
 *  - openclaw-shallow/src/agents/bash-tools.exec-host-node.ts (YOLO bypass)
 *  - Official Android CLI: adb, sdkmanager, apksigner, aapt2, zipalign, bundletool
 */

import { randomUUID } from 'crypto';
import { execSync, spawn } from 'child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type SandboxMode = 'off' | 'non-main' | 'all';

export interface Sandbox {
  id: string;
  name: string;
  workDir: string;
  createdAt: Date;
  status: 'active' | 'paused' | 'destroyed';
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface SecurityPolicy {
  allowedCommands: string[];
  deniedCommands: string[];
  networkRestrictions: boolean;
  auditLogging: boolean;
  credentialEncryption: boolean;
  yoloMode: {
    enabled: boolean;
    requiresHumanConfirm: boolean;
    auditOnYolo: boolean;
    yoloLogsDir: string;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Sandbox Manager (adapted from agentos-core/src/sandbox/manager.ts)
// ───────────────────────────────────────────────────────────────────────────

export class SandboxManager {
  private sandboxes: Map<string, Sandbox> = new Map();
  private baseDir: string;
  private yoloLogsDir: string;

  constructor(baseDir?: string, yoloLogsDir?: string) {
    this.baseDir = baseDir || join(homedir(), '.claude/sandboxes');
    this.yoloLogsDir = yoloLogsDir || join(homedir(), '.claude/yolo-logs');
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.yoloLogsDir, { recursive: true });
  }

  createSandbox(name?: string): Sandbox {
    const id = randomUUID();
    const workDir = join(this.baseDir, id);
    mkdirSync(workDir, { recursive: true });
    const sandbox: Sandbox = {
      id,
      name: name || `sandbox-${id.slice(0, 8)}`,
      workDir,
      createdAt: new Date(),
      status: 'active',
    };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  execute(
    sandboxId: string,
    command: string,
    options?: { timeout?: number; env?: Record<string, string>; yolo?: boolean }
  ): SandboxResult {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || sandbox.status !== 'active') {
      throw new Error(`Sandbox ${sandboxId} not found or inactive`);
    }

    const start = Date.now();
    const actualEnv = {
      ...process.env,
      ...options?.env,
      SANDBOX_ID: sandboxId,
      SANDBOX_DIR: sandbox.workDir,
      ...(options?.yolo && { SANDBOX_YOLO: '1' }),
    };

    // YOLO audit logging (always logged even in YOLO)
    if (options?.yolo) {
      const logEntry = `[${new Date().toISOString()}] YOLO EXEC: ${command}\n`;
      appendFileSync(join(this.yoloLogsDir, `${sandboxId}.log`), logEntry);
    }

    try {
      const stdout = execSync(command, {
        cwd: sandbox.workDir,
        encoding: 'utf-8',
        timeout: options?.timeout || 60000,
        env: actualEnv,
      });
      return { exitCode: 0, stdout: stdout.trim(), stderr: '', duration: Date.now() - start };
    } catch (err: any) {
      return {
        exitCode: err.status || 1,
        stdout: '',
        stderr: err.stderr || err.message,
        duration: Date.now() - start,
      };
    }
  }

  pause(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;
    sandbox.status = 'paused';
    return true;
  }

  resume(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;
    sandbox.status = 'active';
    return true;
  }

  destroy(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;
    try {
      rmSync(sandbox.workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    sandbox.status = 'destroyed';
    this.sandboxes.delete(sandboxId);
    return true;
  }

  listSandboxes(): Sandbox[] {
    return Array.from(this.sandboxes.values());
  }

  destroyAll(): void {
    for (const [id] of this.sandboxes) this.destroy(id);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Security Manager (adapted from agentos-core/src/security/manager.ts)
// ───────────────────────────────────────────────────────────────────────────

export class SecurityManager {
  private policy: SecurityPolicy;

  constructor(policy?: Partial<SecurityPolicy>) {
    this.policy = {
      allowedCommands: [],
      deniedCommands: ['rm -rf /', 'mkfs', 'dd if=', 'fdisk'],
      networkRestrictions: false,
      auditLogging: true,
      credentialEncryption: true,
      yoloMode: {
        enabled: false,
        requiresHumanConfirm: true,
        auditOnYolo: true,
        yoloLogsDir: join(homedir(), '.claude/yolo-logs'),
      },
      ...policy,
    };
  }

  getPolicy(): SecurityPolicy {
    return { ...this.policy };
  }

  updatePolicy(patch: Partial<SecurityPolicy>): void {
    this.policy = { ...this.policy, ...patch };
  }

  enableYolo(): void {
    this.policy.yoloMode.enabled = true;
  }

  disableYolo(): void {
    this.policy.yoloMode.enabled = false;
  }

  isCommandAllowed(command: string): boolean {
    if (this.policy.deniedCommands.some((d) => command.includes(d))) return false;
    if (this.policy.allowedCommands.length === 0) return true;
    return this.policy.allowedCommands.some((a) => command.startsWith(a));
  }

  auditLog(entry: {
    timestamp: Date;
    action: string;
    target: string;
    user?: string;
    result: string;
    yolo?: boolean;
  }): void {
    if (!this.policy.auditLogging) return;
    const prefix = entry.yolo ? '[YOLO-AUDIT]' : '[audit]';
    const line = `${prefix} ${entry.timestamp.toISOString()} ${entry.action} -> ${entry.target} [${entry.result}]`;
    console.log(line);
    appendFileSync(join(this.policy.yoloMode.yoloLogsDir, 'audit.log'), line + '\n');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Android CLI Integration (official tools)
// ───────────────────────────────────────────────────────────────────────────

export const ANDROID_TOOLS = {
  adb: 'adb',
  fastboot: 'fastboot',
  sdkmanager: 'sdkmanager',
  avdmanager: 'avdmanager',
  apksigner: 'apksigner',
  aapt2: 'aapt2',
  zipalign: 'zipalign',
  bundletool: 'bundletool',
  d8: 'd8',
  retrace: 'retrace',
  apkanalyzer: 'apkanalyzer',
} as const;

export class AndroidCli {
  constructor(
    private sandbox: SandboxManager,
    private security: SecurityManager,
    private androidRoot: string = join(homedir(), 'Android/Sdk')
  ) {}

  private toolPath(tool: string): string {
    const candidates = [
      join(this.androidRoot, 'platform-tools', tool),
      join(this.androidRoot, 'cmdline-tools', 'latest', 'bin', tool),
      join(this.androidRoot, 'build-tools', '34.0.0', tool),
      tool, // assume in PATH
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return tool;
  }

  devices(sandboxId: string, yolo = false): SandboxResult {
    const cmd = `${this.toolPath('adb')} devices -l`;
    if (!this.security.isCommandAllowed(cmd) && !yolo) {
      this.security.auditLog({ timestamp: new Date(), action: 'deny', target: cmd, result: 'blocked' });
      return { exitCode: 1, stdout: '', stderr: 'Command denied by policy', duration: 0 };
    }
    return this.sandbox.execute(sandboxId, cmd, { yolo });
  }

  installApk(sandboxId: string, apkPath: string, yolo = false): SandboxResult {
    const cmd = `${this.toolPath('adb')} install -r "${apkPath}"`;
    if (!this.security.isCommandAllowed(cmd) && !yolo) {
      this.security.auditLog({ timestamp: new Date(), action: 'deny', target: cmd, result: 'blocked' });
      return { exitCode: 1, stdout: '', stderr: 'Command denied by policy', duration: 0 };
    }
    return this.sandbox.execute(sandboxId, cmd, { yolo });
  }

  shell(sandboxId: string, shellCmd: string, yolo = false): SandboxResult {
    const cmd = `${this.toolPath('adb')} shell ${shellCmd}`;
    if (!this.security.isCommandAllowed(cmd) && !yolo) {
      this.security.auditLog({ timestamp: new Date(), action: 'deny', target: cmd, result: 'blocked' });
      return { exitCode: 1, stdout: '', stderr: 'Command denied by policy', duration: 0 };
    }
    return this.sandbox.execute(sandboxId, cmd, { yolo });
  }

  verifyApk(sandboxId: string, apkPath: string): SandboxResult {
    const cmd = `${this.toolPath('apksigner')} verify --print-certs "${apkPath}"`;
    return this.sandbox.execute(sandboxId, cmd);
  }

  alignApk(sandboxId: string, input: string, output: string): SandboxResult {
    const cmd = `${this.toolPath('zipalign')} -f 4 "${input}" "${output}"`;
    return this.sandbox.execute(sandboxId, cmd);
  }

  buildApks(sandboxId: string, aabPath: string, outputDir: string): SandboxResult {
    const cmd = `java -jar bundletool.jar build-apks --bundle="${aabPath}" --output="${outputDir}/out.apks" --mode=universal`;
    return this.sandbox.execute(sandboxId, cmd);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Agent-in-Sandbox Launcher (adapted from openclaw acp-spawn)
// ───────────────────────────────────────────────────────────────────────────

export class AgentSandboxLauncher {
  constructor(
    private sandbox: SandboxManager,
    private security: SecurityManager,
    private android: AndroidCli
  ) {}

  /**
   * Launch an agent inside a sandbox.
   * @param agentName - Name of the agent to launch
   * @param yolo - If true, runs with full CLI access (bypasses approval gates)
   */
  async launch(agentName: string, yolo = false): Promise<{ sandboxId: string; result: SandboxResult }> {
    const sandbox = this.sandbox.createSandbox(`agent-${agentName}`);
    this.security.auditLog({
      timestamp: new Date(),
      action: 'agent:launch',
      target: agentName,
      result: yolo ? 'yolo' : 'standard',
      yolo,
    });

    const cmd = yolo
      ? `SANDBOX_YOLO=1 node --import tsx src/main.ts --agent ${agentName} --yolo`
      : `node --import tsx src/main.ts --agent ${agentName}`;

    const result = this.sandbox.execute(sandbox.id, cmd, {
      yolo,
      timeout: 300000, // 5 min default
    });

    return { sandboxId: sandbox.id, result };
  }

  /**
   * Run a single command in a sandbox (agent tool call).
   */
  runInSandbox(sandboxId: string, command: string, yolo = false): SandboxResult {
    return this.sandbox.execute(sandboxId, command, { yolo });
  }

  cleanup(sandboxId: string): boolean {
    return this.sandbox.destroy(sandboxId);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Example Usage
// ───────────────────────────────────────────────────────────────────────────

export function createOmniPikingSandboxSystem() {
  const sandbox = new SandboxManager();
  const security = new SecurityManager({
    allowedCommands: [
      'adb *',
      'fastboot *',
      'sdkmanager *',
      'avdmanager *',
      'apksigner *',
      'aapt2 *',
      'zipalign *',
      'bundletool *',
      'java -jar *',
      'node *',
      'npm *',
    ],
    deniedCommands: ['rm -rf /', 'mkfs', 'dd if=', 'fdisk', 'shutdown', 'reboot'],
    yoloMode: {
      enabled: false,
      requiresHumanConfirm: true,
      auditOnYolo: true,
      yoloLogsDir: join(homedir(), '.claude/yolo-logs'),
    },
  });

  const android = new AndroidCli(sandbox, security);
  const launcher = new AgentSandboxLauncher(sandbox, security, android);

  return { sandbox, security, android, launcher };
}

// CLI-style helper if run directly
if (require.main === module) {
  const { sandbox, security, android, launcher } = createOmniPikingSandboxSystem();

  // Create a sandbox
  const sb = sandbox.createSandbox('demo');
  console.log(`✅ Created sandbox: ${sb.id}`);

  // Run adb devices (standard mode)
  const result = android.devices(sb.id);
  console.log(`📱 adb devices: ${result.stdout || result.stderr}`);

  // Cleanup
  sandbox.destroyAll();
  console.log('🧹 All sandboxes destroyed');
}
