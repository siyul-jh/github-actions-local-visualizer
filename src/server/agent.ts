import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, exec } from 'child_process';
import crypto from 'crypto';
import { MemorySessionStore } from './session-store';
import { LogParser } from './log-parser';
import { SocketEvent, BuildSession } from '../lib/types';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';

const PORT = 3001;
const store = new MemorySessionStore();
const clients = new Set<WebSocket>();
let targetWorkspacePath = process.cwd();
let detectedDockerHost: string | null = null;
const activeProcesses = new Map<string, any>();
store.setWorkspace(targetWorkspacePath);

// 1~3단계 도커 종합 정밀 진단 헬퍼
function runDockerDiagnostic() {
  const { execSync } = require('child_process');
  const extendedPath = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`;
  const home = process.env.HOME || '/Users/ljiheum';

  const result: Record<string, { status: 'success' | 'failure' | 'pending'; message: string }> = {
    step1: { status: 'pending', message: 'Docker CLI 설치 확인 중...' },
    step2: { status: 'pending', message: 'Docker Daemon 상태 확인 중...' },
    step3: { status: 'pending', message: 'Docker 동작 및 권한 검사 중...' }
  };

  // 1단계: Docker 설치 확인
  try {
    const version = execSync('docker --version', { env: { PATH: extendedPath } }).toString().trim();
    result.step1 = { status: 'success', message: `Docker CLI 감지됨: ${version}` };
  } catch (e) {
    result.step1 = { status: 'failure', message: '로컬 시스템에 Docker CLI가 설치되어 있지 않습니다. Docker Desktop 또는 Colima를 설치해 주세요.' };
    return result;
  }

  // 2단계: Docker Daemon 상태 확인 (소켓 파일 생존 확인)
  const socketCandidates = [
    process.env.DOCKER_HOST,
    'unix:///var/run/docker.sock',
    `unix://${home}/.docker/run/docker.sock`,
    `unix://${home}/.colima/default/docker.sock`,
    `unix://${home}/.orbstack/run/docker.sock`
  ].filter(Boolean) as string[];

  let detectedPath: string | null = null;
  for (const host of socketCandidates) {
    if (host.startsWith('unix://')) {
      const filePath = host.replace('unix://', '');
      if (fs.existsSync(filePath)) {
        detectedPath = host;
        break;
      }
    }
  }

  if (detectedPath) {
    result.step2 = { status: 'success', message: `Docker Daemon 소켓 연결망 발견: ${detectedPath}` };
  } else {
    result.step2 = { status: 'failure', message: 'Docker 데몬 소켓 파일을 감지할 수 없습니다. 도커 엔진이 꺼져 있는지 확인해 주세요.' };
    return result;
  }

  // 3단계: Docker 동작 확인 (실행 및 권한 검사)
  try {
    execSync('docker ps -q', { 
      stdio: 'pipe', 
      timeout: 1500,
      env: {
        ...process.env,
        PATH: extendedPath,
        DOCKER_HOST: detectedPath
      }
    });
    result.step3 = { status: 'success', message: 'Docker 동작 검사 완료 (정상 응답 및 소켓 권한 획득)' };
    detectedDockerHost = detectedPath;
  } catch (e: any) {
    const errMsg = e.stderr?.toString() || e.message || '소켓 연결 권한 거부 또는 데몬 시간 초과';
    result.step3 = { status: 'failure', message: `동작 및 권한 에러: ${errMsg.trim()}` };
  }

  return result;
}

// 기존 isDockerRunning 헬퍼
function isDockerRunning(): boolean {
  const diag = runDockerDiagnostic();
  return diag.step1.status === 'success' && diag.step2.status === 'success' && diag.step3.status === 'success';
}

// HTTP 서버 기동
const server = http.createServer((req, res) => {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 1. 활성 세션 정보 조회 API
  if (req.url === '/api/sessions' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sessions = store.activeSessions();
    res.end(JSON.stringify(sessions));
    return;
  }

  // Docker 상태 조회 API
  if (req.url === '/api/docker/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const active = isDockerRunning();
    res.end(JSON.stringify({ active, host: detectedDockerHost }));
    return;
  }

  // Docker 정밀 진단 Flow API
  if (req.url === '/api/docker/diagnostic' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const diagnosticResult = runDockerDiagnostic();
    res.end(JSON.stringify(diagnosticResult));
    return;
  }

  // Docker 기동 API
  if (req.url === '/api/docker/start' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (process.platform === 'darwin') {
      exec('open -g -a Docker', (err) => {
        if (err) {
          console.error('[Docker Start Failed]', err);
        }
      });
      res.end(JSON.stringify({ success: true, message: 'Docker Desktop start command sent.' }));
    } else {
      res.end(JSON.stringify({ success: false, error: 'Platform not supported. Supports macOS only.' }));
    }
    return;
  }

  // 1.5. 워크스페이스 타겟 경로 조회 및 변경 API
  if (req.url === '/api/workspace' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ targetWorkspacePath }));
    return;
  }

  if (req.url === '/api/workspace' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const newPath = payload.path ? path.resolve(payload.path) : null;
        
        if (!newPath || !fs.existsSync(newPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Directory path does not exist' }));
          return;
        }

        targetWorkspacePath = newPath;
        store.setWorkspace(targetWorkspacePath);
        console.log(`[Server] Target workspace path updated to: ${targetWorkspacePath}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, targetWorkspacePath }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // OS 폴더 선택 대화상자 호출 API (AppleScript 활용)
  if (req.url === '/api/workspace/select' && req.method === 'POST') {
    const selectCmd = `osascript -e 'POSIX path of (choose folder with prompt "Select target project directory:")'`;
    exec(selectCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[Server] Folder picker canceled or failed:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder selection was canceled' }));
        return;
      }
      
      const selectedPath = stdout.trim();
      if (selectedPath && fs.existsSync(selectedPath)) {
        targetWorkspacePath = selectedPath;
        store.setWorkspace(targetWorkspacePath);
        console.log(`[Server] Workspace updated via folder picker: ${targetWorkspacePath}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, targetWorkspacePath }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Selected path does not exist' }));
      }
    });
    return;
  }

  // 워크플로우별 완료된 실행 이력 조회 API
  if (req.url?.startsWith('/api/history') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const file = urlObj.searchParams.get('file') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store.getHistory(file)));
    return;
  }

  // 2. YAML 워크플로우 목록 및 내용 조회 API
  if (req.url?.startsWith('/api/workflows') && req.method === 'GET') {
    const workflowsDir = path.join(targetWorkspacePath, '.github', 'workflows');
    if (!fs.existsSync(workflowsDir)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const fileParam = urlObj.searchParams.get('file');

    if (fileParam) {
      const safePath = path.join(workflowsDir, path.basename(fileParam));
      if (fs.existsSync(safePath)) {
        res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' });
        res.end(fs.readFileSync(safePath, 'utf8'));
        return;
      }
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  // 3. 로컬 act 실행 트리거 API (로컬 진단 flow 가드로직 탑재)
  if (req.url === '/api/trigger' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const args = payload.args || [];
        const forceHostMode = !!payload.forceHostMode;
        const workflowFile = payload.workflowFile || '';

        // forceHostMode가 아닐 때만 도커 가상화 사전 엄격 진단 가드 작동
        if (!forceHostMode) {
          const diagnostic = runDockerDiagnostic();
          const hasFailedStep = [diagnostic.step1, diagnostic.step2, diagnostic.step3].some(step => step.status === 'failure');
          
          if (hasFailedStep) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: false, 
              error: 'Docker 사전 진단 플로우를 통과하지 못했습니다. (로컬 환경 불충분)', 
              diagnostic 
            }));
            return;
          }
        }
        
        // 4단계: 워크플로우 실행
        const sessionId = triggerActRun(args, forceHostMode, workflowFile);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: forceHostMode ? '로컬 호스트 쉘 모드로 워크플로우 실행 기동 완료' : 'Docker 진단 통과 및 워크플로우 실행 기동 완료',
          sessionId
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // 3.5. 실행 중인 세션 중단 API
  if (req.url === '/api/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { sessionId } = payload;
        
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session ID is required' }));
          return;
        }
 
        const proc = activeProcesses.get(sessionId);
        if (proc) {
          console.log(`[Server] Killing active process group for session ${sessionId} (PID: ${proc.pid})...`);
          try {
            // 확실한 자식 리소스 정리 및 중단을 위해 SIGKILL 프로세스 그룹 폭파 시도
            process.kill(-proc.pid, 'SIGKILL');
          } catch (e: any) {
            try {
              proc.kill('SIGKILL');
            } catch (err) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Cancellation signal sent' }));
        } else {
          // 이미 프로세스가 소멸되었으나 UI가 멈춰있을 경우 복구 조치
          console.log(`[Server] Process already completed. Force updating session status to completed for: ${sessionId}`);
          store.completeSession(sessionId, 'completed');
          
          const finalSession = store.getSession(sessionId);
          if (finalSession) {
            broadcast({
              event: 'session_sync',
              session: finalSession
            });
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Session state sync force-completed' }));
        }
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// WebSocket 서버 초기화
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected. Total clients: ${clients.size}`);

  // 신규 접속한 클라이언트에게 현재 활성 세션들의 초기 상태를 즉시 전송
  const activeSessions = store.activeSessions();
  for (const session of activeSessions) {
    ws.send(JSON.stringify({
      event: 'session_sync',
      session
    }));
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total clients: ${clients.size}`);
  });
});

// 클라이언트 전체 브로드캐스트
function broadcast(event: SocketEvent | { event: 'session_sync'; session: BuildSession }) {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// act 프로세스 구동 및 래핑
function triggerActRun(extraArgs: string[] = [], forceHostMode: boolean = false, workflowFile: string = ''): string {
  const sessionId = crypto.randomUUID();
  const session = store.createSession(sessionId, workflowFile);
  const parser = new LogParser(sessionId);
  
  // 신규 세션 생성 및 웹소켓 알림
  broadcast({
    event: 'session_created',
    sessionId,
    timestamp: session.createdAt,
    payload: {
        triggerEvent: 'push',
      actor: 'local-user',
      ref: 'refs/heads/main'
    }
  });

  // .actrc 파일이 없거나 설정이 부족한 경우 자동으로 감지하여 생성/보완 (비전공자 자동 조치 기능)
  try {
    const actrcPath = path.join(targetWorkspacePath, '.actrc');
    const mappingLine = '-P ubuntu-latest=catthehacker/ubuntu:act-latest';
    const selfHostedMappingLine = '-P self-hosted=catthehacker/ubuntu:act-latest';
    const containerArchLine = '--container-architecture linux/amd64';
    
    let shouldWrite = false;
    let fileContent = '';

    if (!fs.existsSync(actrcPath)) {
      fileContent = `${mappingLine}\n${selfHostedMappingLine}\n${containerArchLine}\n`;
      shouldWrite = true;
      console.log(`[Server] .actrc not found in workspace. Auto-creating at ${actrcPath}...`);
    } else {
      fileContent = fs.readFileSync(actrcPath, 'utf8');
      const lines = fileContent.split('\n').map(l => l.trim());
      
      let updatedContent = fileContent;
      let wasModified = false;

      if (!lines.some(l => l.includes('ubuntu-latest='))) {
        updatedContent += `\n${mappingLine}`;
        wasModified = true;
      }
      if (!lines.some(l => l.includes('self-hosted='))) {
        updatedContent += `\n${selfHostedMappingLine}`;
        wasModified = true;
      }
      if (process.platform === 'darwin' && !lines.some(l => l.includes('--container-architecture'))) {
        updatedContent += `\n${containerArchLine}`;
        wasModified = true;
      }

      if (wasModified) {
        fileContent = updatedContent;
        shouldWrite = true;
        console.log(`[Server] Existing .actrc updated with recommended local mappings.`);
      }
    }

    if (shouldWrite) {
      fs.writeFileSync(actrcPath, fileContent.trim() + '\n', 'utf8');
    }
  } catch (err: any) {
    console.error(`[Server] Failed to auto-provision .actrc: ${err.message}`);
  }

  console.log(`[Server] Starting act execution for session ${sessionId} in ${targetWorkspacePath}...`);

  const baseArgs: string[] = [];
  const dockerActive = isDockerRunning();

  if (dockerActive && !forceHostMode) {
    console.log('[Server] Docker daemon detected. Running in Docker Container mode.');
    // 사용자의 맥 아키텍처 호환성 보장
    if (process.platform === 'darwin') {
      baseArgs.push('--container-architecture', 'linux/amd64');
    }
    // self-hosted 플랫폼을 act용 컨테이너 이미지에 매핑
    baseArgs.push('-P', 'self-hosted=catthehacker/ubuntu:act-latest');
    // ubuntu-latest를 act용 표준 경량 러너 이미지로 명시 매핑하여 pull access denied 에러 예방
    baseArgs.push('-P', 'ubuntu-latest=catthehacker/ubuntu:act-latest');
  } else {
    console.log(`[Server] ${forceHostMode ? 'Force Host Mode enabled' : 'Docker daemon NOT active'}. Running in Host Direct execution mode.`);
    // 도커 미기동 또는 호스트 모드 강제 실행 시 모든 플랫폼을 호스트 쉘로 리다이렉트 (-self-hosted)
    baseArgs.push('-P', 'self-hosted=-self-hosted');
    baseArgs.push('-P', 'ubuntu-latest=-self-hosted');
    
    // UI 로그 버퍼에 가이드 문구 주입 (특정 Job만 실행(-j)한 경우 그 Job에, 아니면 시스템 안내용 가상 ID에 귀속)
    const targetJobFlagIdx = extraArgs.indexOf('-j');
    const guideJobId = targetJobFlagIdx !== -1 ? extraArgs[targetJobFlagIdx + 1] : '__setup__';
    setTimeout(() => {
      broadcast({
        event: 'log_emitted',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: guideJobId,
          log: forceHostMode
            ? '⚠️  사용자의 요청에 따라 [호스트 로컬 쉘 직접 실행 모드]로 안전하게 우회 실행합니다.\n'
            : '⚠️  로컬 Docker 데몬 연결에 실패하여 [호스트 로컬 쉘 직접 실행 모드]로 안전하게 우회 실행합니다. (도커 설치가 생략됨)\n'
        }
      });
    }, 200);
  }

  // 특정 Job만(-j) 실행하는 경우, 그 Job의 needs를 제거한 임시 워크플로우로 실행해 선행 Job이 함께 돌지 않도록 격리
  let standaloneTempFile: string | null = null;
  const jobFlagIdx = extraArgs.indexOf('-j');
  const workflowFlagIdx = extraArgs.indexOf('-W');
  if (jobFlagIdx !== -1 && workflowFlagIdx !== -1) {
    const targetJobId = extraArgs[jobFlagIdx + 1];
    const originalWorkflowPath = path.join(targetWorkspacePath, extraArgs[workflowFlagIdx + 1]);
    try {
      const parsed = yaml.parse(fs.readFileSync(originalWorkflowPath, 'utf8'));
      if (parsed?.jobs?.[targetJobId]) {
        delete parsed.jobs[targetJobId].needs;
        standaloneTempFile = path.join(os.tmpdir(), `act-standalone-${crypto.randomUUID()}.yml`);
        fs.writeFileSync(standaloneTempFile, yaml.stringify(parsed), 'utf8');
        extraArgs[workflowFlagIdx + 1] = standaloneTempFile;
        console.log(`[Server] Running job '${targetJobId}' standalone (needs stripped) via ${standaloneTempFile}`);
      }
    } catch (err: any) {
      console.error(`[Server] Failed to prepare standalone job workflow: ${err.message}`);
    }
  }

  const finalArgs = [...baseArgs, ...extraArgs];
  console.log(`[Server] Final act command: act ${finalArgs.join(' ')}`);

  const extendedPath = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`;
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: extendedPath
  };
  if (detectedDockerHost) {
    spawnEnv.DOCKER_HOST = detectedDockerHost;
  }

  // act 명령어 스폰 (프로세스 그룹 전체 강제 종료 및 인자 분해 방지를 위해 shell: false 지정)
  const actProcess = spawn('act', finalArgs, {
    cwd: targetWorkspacePath,
    shell: false,
    env: spawnEnv,
    detached: true
  }) as any;

  // 실행 프로세스 전역 등록
  activeProcesses.set(sessionId, actProcess);

  // stdout 파싱 및 스트리밍
  actProcess.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    const lines = chunk.split('\n');

    for (const line of lines) {
      const cleanLine = line.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!cleanLine) continue;

      console.log(`[act stdout] ${cleanLine}`);

      // 로그 정규식 파싱
      const parsedEvent = parser.parseLine(cleanLine);
      if (parsedEvent) {
        // 인메모리 스토어 상태 반영
        if (parsedEvent.event === 'job_status') {
          store.updateJobStatus(sessionId, parsedEvent.payload.jobId, parsedEvent.payload.workflow, parsedEvent.payload.status);
        } else if (parsedEvent.event === 'step_status') {
          store.updateStepStatus(sessionId, parsedEvent.payload.jobId, parsedEvent.payload.stepName, parsedEvent.payload.status);
        } else if (parsedEvent.event === 'log_emitted') {
          store.updateJobStatus(sessionId, parsedEvent.payload.jobId, 'Workflow', 'running'); // 안전 장치: 로그가 도달했을 때 Job 상태 보정
          store.appendLog(sessionId, parsedEvent.payload.jobId, parsedEvent.payload.log);
        }

        // 웹소켓 브로드캐스트
        broadcast(parsedEvent);
      } else {
        // 파싱 룰에 매칭되지 않는 일반 라인도 기본 로그로 백업 브로드캐스트 수행
        // 단, Job 정보 식별이 어려운 경우 세션 로깅 보존을 위해 마지막에 매칭된 Job을 임시 추적
        // (단순 구현에서는 T1의 로깅 누락 보정을 위해, 세션의 임의 첫 번째 Job 또는 "general" Job 로그로 취급 가능)
        const jobKeys = Object.keys(session.jobs);
        if (jobKeys.length > 0) {
          const defaultJobId = jobKeys[jobKeys.length - 1];
          store.appendLog(sessionId, defaultJobId, cleanLine);
          broadcast({
            event: 'log_emitted',
            sessionId,
            timestamp: new Date().toISOString(),
            payload: {
              jobId: defaultJobId,
              log: cleanLine
            }
          });
        }
      }
    }
  });

  // stderr 로깅
  actProcess.stderr.on('data', (data: Buffer) => {
    const cleanLine = data.toString().replace(/\x1b\[[0-9;]*m/g, '').trim();
    console.error(`[act stderr] ${cleanLine}`);
    
    const jobKeys = Object.keys(session.jobs);
    if (jobKeys.length > 0) {
      const defaultJobId = jobKeys[jobKeys.length - 1];
      store.appendLog(sessionId, defaultJobId, `[stderr] ${cleanLine}`);
      broadcast({
        event: 'log_emitted',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          jobId: defaultJobId,
          log: `[stderr] ${cleanLine}`
        }
      });
    }
  });

  actProcess.on('close', (code: number | null) => {
    console.log(`[Server] act execution finished with exit code ${code} for session ${sessionId}`);
    store.completeSession(sessionId, 'completed');

    // 단독 실행용 임시 워크플로우 파일 정리
    if (standaloneTempFile) {
      fs.unlink(standaloneTempFile, () => {});
    }

    // 프로세스 등록 해제
    activeProcesses.delete(sessionId);

    // 세션 전체 최종 상태를 클라이언트에 동기화 브로드캐스트하여 UI 스피너 정지
    const finalSession = store.getSession(sessionId);
    if (finalSession) {
      broadcast({
        event: 'session_sync',
        session: finalSession
      });
    }
    
    // 강제 종료 시 Job 상태 보정
    const currentSession = store.getSession(sessionId);
    if (currentSession) {
      for (const jobId of Object.keys(currentSession.jobs)) {
        if (currentSession.jobs[jobId].status === 'running') {
          store.updateJobStatus(sessionId, jobId, currentSession.jobs[jobId].workflow, code === 0 ? 'success' : 'failure');
          broadcast({
            event: 'job_status',
            sessionId,
            timestamp: new Date().toISOString(),
            payload: {
              jobId,
              workflow: currentSession.jobs[jobId].workflow,
              status: code === 0 ? 'success' : 'failure'
            }
          });
        }
      }
    }

    // 5단계: Docker 종료 확인 (Clean up 리소스 소멸 검사)
    setTimeout(() => {
      try {
        const { execSync } = require('child_process');
        const extendedPath = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`;
        const cmdEnv = { ...process.env, PATH: extendedPath };
        if (detectedDockerHost) {
          (cmdEnv as any).DOCKER_HOST = detectedDockerHost;
        }
        
        // act가 스폰한 컨테이너 잔재가 있는지 쿼리
        const output = execSync('docker ps -a --filter label=act --format "{{.ID}}"', { env: cmdEnv }).toString().trim();
        if (output === '') {
          broadcast({
            event: 'docker_cleanup',
            sessionId,
            timestamp: new Date().toISOString(),
            payload: { status: 'success', message: 'Docker 리소스 정리 완료 (임시 가상 환경 정상 해제)' }
          });
        } else {
          broadcast({
            event: 'docker_cleanup',
            sessionId,
            timestamp: new Date().toISOString(),
            payload: { status: 'failure', message: '경고: act가 생성한 임시 컨테이너 잔재가 존재합니다.' }
          });
        }
      } catch (err: any) {
        broadcast({
          event: 'docker_cleanup',
          sessionId,
          timestamp: new Date().toISOString(),
          payload: { status: 'failure', message: `리소스 정리 점검 실패: ${err.message}` }
        });
      }
    }, 1500);
  });

  return sessionId;
}

// 서버 실행 시작
server.listen(PORT, () => {
  console.log(`[Agent Server] Started on http://localhost:${PORT}`);
  console.log(`[Agent Server] WebSocket server active on ws://localhost:${PORT}`);
  
  console.log('[Agent Server] Boot-time Docker detection check...');
  const isDockerOk = isDockerRunning();
  console.log(`[Agent Server] Boot-time Docker state: ${isDockerOk ? 'ACTIVE 🟢' : 'INACTIVE ❌'}`);
});
