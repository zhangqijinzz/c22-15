import { describe, expect, it } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { createDemoWorkspace } from '../models/projectFactory';
import type { WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from './ruleRepository';

class StubStorage {
  constructor(private value: unknown) {}
  async read(): Promise<unknown> { return this.value; }
  readFallback(): unknown { return null; }
  async write(): Promise<void> { return undefined; }
}

const analysisShape = () => ({
  checkedCases: 12,
  coveredCases: 9,
  coveragePercent: 75,
  overlaps: [{ ruleAId: 'r1', ruleBId: 'r2', conflict: true, witness: { amount: 1 } }],
  unreachableRuleIds: ['r3'],
  shadowedRuleIds: [],
  uncoveredExamples: [{ amount: 0 }],
  truncated: false,
});

const versionBase = (extra: Record<string, unknown> = {}) => ({
  id: 'v1',
  name: '版本 1',
  savedAt: 123,
  frozen: false,
  fields: [{ id: 'f1', name: '金额', type: 'number', min: 0, max: 10 }],
  rules: [{ id: 'r1', name: '规则一', priority: 10, result: '通过', conditions: { kind: 'group', operator: 'and', conditions: [] } }],
  sampleInputs: {},
  ...extra,
});

const documentWithVersion = (version: unknown): WorkspaceDocument => {
  const workspace = createDemoWorkspace();
  return {
    ...workspace,
    activeProjectId: workspace.projects[0].id,
    projects: [{ ...workspace.projects[0], versions: [version as never] }],
  };
};

describe('RuleRepository version decoding', () => {
  it('restores a pinned check conclusion saved on the version', async () => {
    const document = documentWithVersion(versionBase({ check: { checkedAt: 456, analysis: analysisShape() } }));
    const repository = new RuleRepository(new StubStorage(document) as never);
    const restored = await repository.load();
    const version = restored?.projects[0].versions[0];
    expect(version?.check?.checkedAt).toBe(456);
    expect(version?.check?.analysis.coveragePercent).toBe(75);
    expect(version?.check?.analysis.overlaps[0]).toMatchObject({ ruleAId: 'r1', conflict: true });
    expect(version?.check?.analysis.unreachableRuleIds).toEqual(['r3']);
  });

  it('loads historical versions without a check as unchecked', async () => {
    const document = documentWithVersion(versionBase());
    const repository = new RuleRepository(new StubStorage(document) as never);
    const restored = await repository.load();
    expect(restored?.projects[0].versions[0].check).toBeUndefined();
  });

  it('rejects a version whose pinned analysis is malformed', async () => {
    const malformed = versionBase({ check: { checkedAt: 456, analysis: { coveragePercent: 'not-a-number' } } });
    const document = documentWithVersion(malformed);
    const repository = new RuleRepository(new StubStorage(document) as never);
    await expect(repository.load()).resolves.toBeNull();
  });

  it('round-trips a real analysis produced by the domain checker', async () => {
    const workspace = createDemoWorkspace();
    const project = workspace.projects[0];
    const analysis = analyzeRules(project);
    const document: WorkspaceDocument = {
      ...workspace,
      projects: [{ ...project, versions: [{ id: 'v1', name: '冻结版本 1', savedAt: 1, frozen: true, fields: project.fields, rules: project.rules, sampleInputs: project.sampleInputs, check: { checkedAt: 2, analysis } }] }],
    };
    const repository = new RuleRepository(new StubStorage(document) as never);
    const restored = await repository.load();
    expect(restored?.projects[0].versions[0].check?.analysis).toEqual(analysis);
  });
});
