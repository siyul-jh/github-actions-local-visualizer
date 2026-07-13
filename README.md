# GitHub Actions Local Visualizer

[`act`](https://github.com/nektos/act)으로 GitHub Actions 워크플로우를 로컬에서 실행하고, 그 진행 상황을 실시간 그래프·로그로 시각화하는 도구입니다.

## 주요 기능

- **정적 워크플로우 그래프**: `.github/workflows/*.yml`의 Job 의존성(`needs`)을 DAG로 시각화
- **실시간 세션 뷰**: 워크플로우 실행 중 Job/Step 상태와 로그를 그래프에 실시간 반영
- **어노테이션**: 로그에서 오류/경고를 자동 추출, 타입별·Step별 필터링 지원
- **Job 단위 개별 실행**: 특정 Job만 실행 (`needs` 의존 체인을 격리한 임시 워크플로우로 실행)
- **실행 이력 관리**: 워크플로우 파일별 완료된 실행 이력을 저장하고, 과거 실행을 다시 열람
- **Docker 상태 진단**: Docker Desktop 미기동 시 자동 진단 및 안내, 필요 시 호스트 직접 실행 모드로 우회

## 요구 사항

- Node.js
- [`act`](https://github.com/nektos/act) CLI (`brew install act`)
- Docker Desktop (선택 — 없으면 호스트 쉘 직접 실행 모드로 동작)

## 시작하기

프론트엔드(Next.js)와 백엔드(실행 에이전트)를 각각 실행해야 합니다.

```bash
npm install

# 터미널 1: 웹 UI
npm run dev

# 터미널 2: act 실행/모니터링 백엔드
npm run agent
```

- 웹 UI: [http://localhost:3000](http://localhost:3000)
- 백엔드 API/WebSocket: `http://localhost:3001`

웹 UI에서 "폴더 선택"으로 GitHub Actions 워크플로우가 있는 대상 프로젝트를 연결한 뒤 워크플로우를 실행하면 됩니다.
