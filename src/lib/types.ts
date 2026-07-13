export interface BuildStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failure';
  startedAt?: string;
  completedAt?: string;
}

export interface BuildJob {
  jobId: string;
  workflow: string;
  status: 'pending' | 'running' | 'success' | 'failure';
  steps: BuildStep[];
  logs: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface BuildSession {
  sessionId: string;
  createdAt: string;
  completedAt?: string;
  status: 'running' | 'completed';
  workflowFile?: string;
  jobs: Record<string, BuildJob>; // JSON 직렬화를 위해 Map 대신 Record 사용
}

export type SocketEvent =
  | {
      event: 'session_created';
      sessionId: string;
      timestamp: string;
      payload: {
        triggerEvent: string;
        actor: string;
        ref: string;
      };
    }
  | {
      event: 'job_status';
      sessionId: string;
      timestamp: string;
      payload: {
        jobId: string;
        workflow: string;
        status: 'pending' | 'running' | 'success' | 'failure';
      };
    }
  | {
      event: 'step_status';
      sessionId: string;
      timestamp: string;
      payload: {
        jobId: string;
        stepName: string;
        status: 'pending' | 'running' | 'success' | 'failure';
      };
    }
  | {
      event: 'log_emitted';
      sessionId: string;
      timestamp: string;
      payload: {
        jobId: string;
        log: string;
      };
    }
  | {
      event: 'docker_cleanup';
      sessionId: string;
      timestamp: string;
      payload: {
        status: 'success' | 'failure';
        message: string;
      };
    };
