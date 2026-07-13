# 시스템 아키텍처 설계서: GitHub Actions 로컬 시각화/모니터링 서비스

본 문서는 로컬 개발 환경에서 GitHub Actions의 실시간 진행률 및 빌드 로그를 시각화하고, 워크플로우 YAML 구조를 파싱해 그래프로 보여주는 서비스의 아키텍처 설계 사양을 정의합니다.

---

## 1. act 로그 포맷 분석 및 파싱 패턴 (T1)

`nektos/act` 실행 시 콘솔에 출력되는 표준 포맷을 파싱하여 빌드 상태(Job, Step, Log)를 감지합니다.

### 1.1. 주요 출력 패턴 및 정규식 정의

1. **Job 시작 및 완료 감지**
   - **Job 시작**: `[Workflow Name/Job Name] 🚀  Start image=...`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+🚀\s+Start\s+image=(.+)$`
     - 매칭 그룹: `1: Workflow`, `2: Job`, `3: Image`
   - **Job 완료 (성공)**: `[Workflow Name/Job Name] 🏁  Job succeeded`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+🏁\s+Job succeeded$`
   - **Job 완료 (실패)**: `[Workflow Name/Job Name] ❌  Job failed`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+❌\s+Job failed$`

2. **Step 진행 상태 감지**
   - **Step 시작**: `[Workflow Name/Job Name]   💬  ::group::[Step Name]` 또는 `[Workflow Name/Job Name] 🌟  Run [Step Name]`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+(?:💬\s+::group::|🌟\s+Run\s+)(.+)$`
   - **Step 완료 (성공)**: `[Workflow Name/Job Name]   ✅  Success - [Step Name]`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+✅\s+Success\s+-\s+(.+)$`
   - **Step 완료 (실패)**: `[Workflow Name/Job Name]   ❌  Failure - [Step Name]`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+❌\s+Failure\s+-\s+(.+)$`

3. **콘솔 로그 스트리밍**
   - **일반 출력**: `[Workflow Name/Job Name]   | [Log Message]`
     - 정규식: `^\[([^/]+)\/([^\]]+)\]\s+\|\s+(.+)$`
     - 매칭 그룹: `1: Workflow`, `2: Job`, `3: Log Message`

---

## 2. CLI-to-Web 실시간 WebSocket 프로토콜 설계 (T2)

CLI Wrapper와 웹 대시보드 간의 실시간 단방향/양방향 이벤트 스트리밍 규격입니다.

### 2.1. JSON 이벤트 메시지 규격

1. **세션 생성 이벤트 (`session_created`)**
   ```json
   {
     "event": "session_created",
     "sessionId": "550e8400-e29b-41d4-a716-446655440000",
     "timestamp": "2026-07-08T17:10:00Z",
     "payload": {
       "triggerEvent": "push",
       "actor": "local-user",
       "ref": "refs/heads/main"
     }
   }
   ```

2. **Job 상태 업데이트 이벤트 (`job_status`)**
   ```json
   {
     "event": "job_status",
     "sessionId": "550e8400-e29b-41d4-a716-446655440000",
     "timestamp": "2026-07-08T17:10:02Z",
     "payload": {
       "jobId": "build",
       "workflow": "CI Pipeline",
       "status": "running|success|failure"
     }
   }
   ```

3. **Step 상태 업데이트 이벤트 (`step_status`)**
   ```json
   {
     "event": "step_status",
     "sessionId": "550e8400-e29b-41d4-a716-446655440000",
     "timestamp": "2026-07-08T17:10:05Z",
     "payload": {
       "jobId": "build",
       "stepName": "Install Dependencies",
       "status": "running|success|failure"
     }
   }
   ```

4. **실시간 로그 수집 이벤트 (`log_emitted`)**
   ```json
   {
     "event": "log_emitted",
     "sessionId": "550e8400-e29b-41d4-a716-446655440000",
     "timestamp": "2026-07-08T17:10:06Z",
     "payload": {
       "jobId": "build",
       "log": "npm WARN deprecated source-map-url@0.4.1..."
     }
   }
   ```

---

## 3. 다중 병렬 빌드 인메모리 세션 스토어 (T3)

동시에 기동되는 여러 개의 `act` 빌드 세션을 독립적으로 격리 관리하기 위한 백엔드 RAM 세션 관리 모델입니다.

```typescript
// src/server/session-store.ts
export interface BuildStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failure';
  startedAt?: Date;
  completedAt?: Date;
}

export interface BuildJob {
  jobId: string;
  workflow: string;
  status: 'pending' | 'running' | 'success' | 'failure';
  steps: BuildStep[];
  logs: string[];
}

export interface BuildSession {
  sessionId: string;
  createdAt: Date;
  status: 'running' | 'completed';
  jobs: Map<string, BuildJob>; // Key: jobId
}

class MemorySessionStore {
  private sessions = new Map<string, BuildSession>();

  public createSession(sessionId: string): BuildSession {
    const session: BuildSession = {
      sessionId,
      createdAt: new Date(),
      status: 'running',
      jobs: new Map()
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): BuildSession | undefined {
    return this.sessions.get(sessionId);
  }

  public activeSessions(): BuildSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running');
  }

  public clear(): void {
    this.sessions.clear(); // 서버 종료 및 재시작 시 휘발성 초기화 수행
  }
}
```

---

## 4. React Flow 기반 대시보드 UI 및 정적 뷰어 (T4)

실시간 빌드 상태 렌더링 및 YAML 정적 그래프 뷰어를 위한 프론트엔드 구성 요소 설계입니다.

### 4.1. 대시보드 UI 레이아웃 설계

1. **사이드바 (Session Explorer)**:
   - 현재 기동 중인 활성 세션(Active Sessions) 및 최근 완료된 세션 목록 카드 형태 조회.
   - 각 세션의 총 소요시간 및 성공/실패 여부를 축소 형태로 시각화.
2. **중앙 캔버스 (React Flow Pipeline Canvas)**:
   - 선택된 세션의 Job들과 `needs` 의존성을 분석하여 방향성 그래프(DAG) 형태 자동 배치 렌더링.
   - 각 노드(Job)의 색상을 현재 상태(`pending`: 회색, `running`: 파란색/스피너, `success`: 녹색, `failure`: 빨간색)에 맞춰 실시간 갱신.
3. **하단 패널 (Real-time Logger)**:
   - 그래프에서 클릭하여 선택한 Job의 콘솔 로그를 Xterm.js 스타일로 렌더링.

### 4.2. YAML 정적 파이프라인 그래프 변환 메커니즘
- 로컬 디렉토리의 YAML 파일을 `yaml` 라이브러리로 로드합니다.
- YAML 내 `jobs` 필드를 순회하며 Node 리스트를 추출합니다.
- 각 Job의 `needs` 배열을 파싱하여 Edge(연결선) 리스트를 구성합니다.
- `dagre` 또는 `elkjs`와 같은 자동 레이아웃 알고리즘을 사용해 React Flow의 `position` 좌표(x, y)를 자동 계산하여 노드를 배치합니다.

---

## 5. 예외 대응 설계 (T5)

- **WebSocket 연결 단절(Disconnection)**: 브라우저 클라이언트가 끊김을 감지할 경우 3초마다 재시도를 수행하는 지수 백오프 기반 재연결 정책을 구현하고, 연결이 유실되는 동안 들어온 로그는 유실되지 않도록 서버가 마지막 500줄의 링 버퍼(Ring Buffer)를 유지하여 제공합니다.
- **프로세스 갑작스런 중단(SIGINT 등)**: CLI 래퍼가 비정상 종료 시 해당 세션 상태를 `failure`로 강제 업데이트 후 소켓 클라이언트에 브로캐스팅합니다.
