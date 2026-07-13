import { SocketEvent } from '../lib/types';

export class LogParser {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  public parseLine(line: string): SocketEvent | null {
    // 1. Job 시작 패턴
    const jobStartMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+🚀\s+Start\s+image=(.+)$/);
    if (jobStartMatch) {
      return {
        event: 'job_status',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: jobStartMatch[2].trim(),
          workflow: jobStartMatch[1].trim(),
          status: 'running'
        }
      };
    }

    // 2. Job 완료 (성공) 패턴
    const jobSuccessMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+🏁\s+Job succeeded$/);
    if (jobSuccessMatch) {
      return {
        event: 'job_status',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: jobSuccessMatch[2].trim(),
          workflow: jobSuccessMatch[1].trim(),
          status: 'success'
        }
      };
    }

    // 3. Job 완료 (실패) 패턴
    const jobFailureMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+🏁\s+Job failed$/);
    if (jobFailureMatch) {
      return {
        event: 'job_status',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: jobFailureMatch[2].trim(),
          workflow: jobFailureMatch[1].trim(),
          status: 'failure'
        }
      };
    }

    // 4. Step 시작 패턴
    const stepStartMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+(?:💬\s+::group::|⭐\s+Run\s+)(.+)$/);
    if (stepStartMatch) {
      return {
        event: 'step_status',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: stepStartMatch[2].trim(),
          stepName: stepStartMatch[3].trim(),
          status: 'running'
        }
      };
    }

    // 5. Step 완료 (성공) 패턴
    const stepSuccessMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+✅\s+Success\s+-\s+(.+?)(?:\s+\[[0-9hms.]+\])?$/);
    if (stepSuccessMatch) {
      return {
        event: 'step_status',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: stepSuccessMatch[2].trim(),
          stepName: stepSuccessMatch[3].trim(),
          status: 'success'
        }
      };
    }

    // 6. Step 완료 (실패) 패턴
    const stepFailureMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+❌\s+Failure\s+-\s+(.+?)(?:\s+\[[0-9hms.]+\])?$/);
    if (stepFailureMatch) {
      return {
        event: 'step_status',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: stepFailureMatch[2].trim(),
          stepName: stepFailureMatch[3].trim(),
          status: 'failure'
        }
      };
    }

    // 7. 일반 콘솔 로그 패턴
    const logMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+\|\s+(.+)$/);
    if (logMatch) {
      return {
        event: 'log_emitted',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: logMatch[2].trim(),
          log: logMatch[3]
        }
      };
    }

    // 매칭되는 정형 로그가 아니지만 일반 출력 형태인 경우에 대한 대비
    const genericLogMatch = line.match(/^\[([^/]+)\/([^\]]+)\]\s+(.+)$/);
    if (genericLogMatch) {
      return {
        event: 'log_emitted',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: genericLogMatch[2].trim(),
          log: genericLogMatch[3]
        }
      };
    }

    return null;
  }
}
