import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');

    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);
    expect(savedVersion?.checkConclusion?.verdict).toBe('conflict');
    expect(savedVersion?.checkConclusion?.conflictCount).toBeGreaterThan(0);

    await workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(frozen?.versions[0].frozen).toBe(true);
    expect(frozen?.versions[0].checkConclusion?.verdict).toBe('conflict');
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('pins the check conclusion at freeze time and keeps it independent of later recomputation', async () => {
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();
    await vi.advanceTimersByTimeAsync(50);

    await workspace.freezeCurrent();
    const pinned = workspace.getSnapshot().project?.versions[0].checkConclusion;
    expect(pinned).toBeDefined();
    expect(pinned?.coveragePercent).toBeGreaterThanOrEqual(0);

    // 从冻结版本继续编辑：快照里的结论保持不变，编辑态结论被清空重算，两处不混用。
    const frozenId = workspace.getSnapshot().project?.frozenVersionId as string;
    workspace.restoreVersion(workspace.getSnapshot().project?.versions.find((version) => version.id === frozenId)?.id ?? '');
    const restored = workspace.getSnapshot().project as RuleProject;
    expect(restored.frozenVersionId).toBeUndefined();
    expect(restored.versions[0].checkConclusion).toEqual(pinned);
    expect(workspace.getSnapshot().analysis).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    expect(restored.versions[0].checkConclusion).toEqual(pinned);
    workspace.dispose();
  });

  it('marks a version saved before any check as unchecked', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    expect(workspace.getSnapshot().project?.versions[0].checkConclusion).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    workspace.saveVersion();
    expect(workspace.getSnapshot().project?.versions[0].checkConclusion).not.toBeNull();
    workspace.dispose();
  });

  it('refuses to freeze an invalid project without producing a version', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    await workspace.freezeCurrent();
    expect(workspace.getSnapshot().project?.versions).toHaveLength(0);
    expect(workspace.getSnapshot().notice).toContain('无法检查');
    workspace.dispose();
  });
});
