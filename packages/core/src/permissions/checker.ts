import type { PermissionAction, PermissionChecker, PermissionDecision } from '../types.js';

export class AllowAllChecker implements PermissionChecker {
  async check(_action: PermissionAction): Promise<PermissionDecision> {
    return { allowed: true };
  }
}

export class DenyAllChecker implements PermissionChecker {
  async check(_action: PermissionAction): Promise<PermissionDecision> {
    return { allowed: false, reason: 'denied by policy' };
  }
}

export interface InteractiveCallbacks {
  confirm(action: PermissionAction): Promise<boolean>;
}

export class InteractiveChecker implements PermissionChecker {
  constructor(private readonly cb: InteractiveCallbacks) {}

  async check(action: PermissionAction): Promise<PermissionDecision> {
    const ok = await this.cb.confirm(action);
    return ok ? { allowed: true } : { allowed: false, reason: 'denied by user' };
  }
}

export interface PermissionRules {
  bash?: 'allow' | 'deny' | 'prompt';
  write?: 'allow' | 'deny' | 'prompt';
  edit?: 'allow' | 'deny' | 'prompt';
}

export class ConfiguredChecker implements PermissionChecker {
  constructor(
    private readonly rules: PermissionRules,
    private readonly interactive: InteractiveChecker | null,
  ) {}

  async check(action: PermissionAction): Promise<PermissionDecision> {
    const policy =
      action.kind === 'bash' ? this.rules.bash : action.kind === 'write_file' ? this.rules.write : this.rules.edit;

    if (policy === 'allow') return { allowed: true };
    if (policy === 'deny') return { allowed: false, reason: `policy: deny ${action.kind}` };
    if (!this.interactive) return { allowed: false, reason: 'no interactive handler and policy is prompt' };
    return this.interactive.check(action);
  }
}
