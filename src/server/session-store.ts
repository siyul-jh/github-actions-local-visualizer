import { BuildSession, BuildJob, BuildStep } from '../lib/types';
import fs from 'fs';
import path from 'path';

export class MemorySessionStore {
  private sessions = new Map<string, BuildSession>();
  private historyFilePath: string | null = null;

  // 워크스페이스 전환 시 호출: 해당 워크스페이스에 저장된 실행 이력 파일을 로드
  public setWorkspace(workspacePath: string): void {
    this.historyFilePath = path.join(workspacePath, '.gh-actions-history.json');
    this.sessions.clear();
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const raw = JSON.parse(fs.readFileSync(this.historyFilePath, 'utf8')) as BuildSession[];
        for (const session of raw) {
          this.sessions.set(session.sessionId, session);
        }
      }
    } catch (err: any) {
      console.error('[SessionStore] Failed to load history file:', err.message);
    }
  }

  private persist(): void {
    if (!this.historyFilePath) return;
    try {
      const completed = Array.from(this.sessions.values()).filter(s => s.status === 'completed');
      fs.writeFileSync(this.historyFilePath, JSON.stringify(completed, null, 2), 'utf8');
    } catch (err: any) {
      console.error('[SessionStore] Failed to persist history file:', err.message);
    }
  }

  public createSession(sessionId: string, workflowFile = ''): BuildSession {
    const session: BuildSession = {
      sessionId,
      createdAt: new Date().toISOString(),
      status: 'running',
      workflowFile,
      jobs: {}
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  // 워크플로우 파일별 완료된 실행 이력 조회 (최신순)
  public getHistory(workflowFile: string): BuildSession[] {
    return Array.from(this.sessions.values())
      .filter(s => s.status === 'completed' && s.workflowFile === workflowFile)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public getSession(sessionId: string): BuildSession | undefined {
    return this.sessions.get(sessionId);
  }

  public activeSessions(): BuildSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running');
  }

  public updateJobStatus(sessionId: string, jobId: string, workflow: string, status: 'pending' | 'running' | 'success' | 'failure'): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    if (!session.jobs[jobId]) {
      session.jobs[jobId] = {
        jobId,
        workflow,
        status,
        steps: [],
        logs: [],
        startedAt: status === 'running' ? new Date().toISOString() : undefined
      };
    } else {
      session.jobs[jobId].status = status;
    }

    const job = session.jobs[jobId];
    if (status === 'running' && !job.startedAt) {
      job.startedAt = new Date().toISOString();
    } else if (status === 'success' || status === 'failure') {
      if (!job.startedAt) job.startedAt = new Date().toISOString();
      job.completedAt = new Date().toISOString();
    }
  }

  public updateStepStatus(sessionId: string, jobId: string, stepName: string, status: 'pending' | 'running' | 'success' | 'failure'): void {
    const session = this.getSession(sessionId);
    if (!session || !session.jobs[jobId]) return;

    const job = session.jobs[jobId];
    let step = job.steps.find(s => s.name === stepName);

    if (!step) {
      step = { name: stepName, status };
      job.steps.push(step);
    } else {
      step.status = status;
    }

    if (status === 'running') {
      step.startedAt = new Date().toISOString();
    } else if (status === 'success' || status === 'failure') {
      step.completedAt = new Date().toISOString();
    }
  }

  public appendLog(sessionId: string, jobId: string, logLine: string): void {
    const session = this.getSession(sessionId);
    if (!session || !session.jobs[jobId]) return;

    session.jobs[jobId].logs.push(logLine);
  }

  public completeSession(sessionId: string, status: 'completed'): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    this.persist();
  }

  public clear(): void {
    this.sessions.clear();
  }
}
