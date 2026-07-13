"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BuildSession, SocketEvent, BuildJob, BuildStep } from "../lib/types";
import { parseWorkflowYaml } from "../lib/yaml-parser";
import yaml from "yaml";

export default function Dashboard() {
  const [sessions, setSessions] = useState<Record<string, BuildSession>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // 워크플로우 파일 상태
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [selectedWorkflowFile, setSelectedWorkflowFile] = useState<string>("");
  const [workflowContent, setWorkflowContent] = useState<string>("");

  // 워크플로우별 완료된 실행 이력
  const [workflowHistory, setWorkflowHistory] = useState<BuildSession[]>([]);
  const selectedWorkflowFileRef = useRef("");

  // 뷰 모드 제어 ('workflow' = 파일 그래프 조회, 'session' = 실제 빌드 진행도 조회)
  const [viewMode, setViewMode] = useState<"workflow" | "session">("workflow");

  // 워크스페이스 연동 관련 상태
  const [workspacePath, setWorkspacePath] = useState<string>("");
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // 어노테이션 상태 (에러/경고 요약)
  const [annotations, setAnnotations] = useState<
    Record<
      string,
      Array<{
        type: "error" | "warning";
        message: string;
        timestamp: string;
        jobId: string;
        stepName?: string;
      }>
    >
  >({});

  // 실시간 지속 시간 갱신용 틱
  const [tick, setTick] = useState(0);

  // 로그 전체 복사 버튼 피드백
  const [logCopied, setLogCopied] = useState(false);

  // 1. 레이아웃 크기 조절 상태 (사이드바 가로 폭 및 하단 로그 높이)
  const [sidebarWidth, setSidebarWidth] = useState(416); // 기본 26rem (416px)
  const [logPanelHeight, setLogPanelHeight] = useState(320); // 기본 h-80 (320px)

  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingLog, setIsResizingLog] = useState(false);

  // 2. Docker 데몬 상태 제어용 리액트 상태
  const [isDockerActive, setIsDockerActive] = useState<boolean>(false);
  const [dockerHost, setDockerHost] = useState<string>("");
  const [isDockerStarting, setIsDockerStarting] = useState<boolean>(false);

  // 3. 5단계 진단 플로우 상태 (백그라운드 트래킹 용도)
  const [diagSteps, setDiagSteps] = useState({
    step1: {
      status: "idle" as "idle" | "running" | "success" | "failure",
      message: "",
    },
    step2: {
      status: "idle" as "idle" | "running" | "success" | "failure",
      message: "",
    },
    step3: {
      status: "idle" as "idle" | "running" | "success" | "failure",
      message: "",
    },
    step4: {
      status: "idle" as "idle" | "running" | "success" | "failure",
      message: "",
    },
    step5: {
      status: "idle" as "idle" | "running" | "success" | "failure",
      message: "",
    },
  });

  // Docker 진단 오류 대처 가이드 모달 상태
  const [isDiagModalOpen, setIsDiagModalOpen] = useState<boolean>(false);
  const [diagModalTitle, setDiagModalTitle] = useState<string>("");
  const [diagModalError, setDiagModalError] = useState<string>("");
  const [diagModalGuide, setDiagModalGuide] = useState<React.ReactNode | null>(
    null,
  );

  // 4. 좌측 패널 내부 각 섹션별 세로 높이 상태 (델타 조절식)
  const [workflowHeight, setWorkflowHeight] = useState(250); // YAML 워크플로우 선택
  const [detailHeight, setDetailHeight] = useState(300); // 실행 상세 정보
  const [jobsHeight, setJobsHeight] = useState(320); // Jobs & Steps

  // 5. 좌측 패널 내부 각 섹션 헤더 클릭 시 접힘/펼침 상태
  const [workflowCollapsed, setWorkflowCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [jobsCollapsed, setJobsCollapsed] = useState(false);
  const [annotationCollapsed, setAnnotationCollapsed] = useState(false);

  // 어노테이션 타입 필터 (null = 전체 표시)
  const [annotationFilter, setAnnotationFilter] = useState<
    "error" | "warning" | null
  >(null);
  // 어노테이션 Step 필터 (null = 전체 표시)
  const [annotationStepFilter, setAnnotationStepFilter] = useState<
    string | null
  >(null);

  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const jobElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const stepElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const annotationElementsRef = useRef<Record<number, HTMLDivElement | null>>(
    {},
  );
  // job별 "현재 진행 중인 step" 추적 (어노테이션 발생 지점을 step 단위로 귀속시키기 위함)
  const currentStepByJobRef = useRef<Record<string, string>>({});

  // 1초 단위 타이머 가동 (실시간 경과 시간 계산용)
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 주기적으로 Docker 데몬 상태 조회 (5초 간격 폴링)
  useEffect(() => {
    const checkDockerStatus = () => {
      fetch("http://localhost:3001/api/docker/status")
        .then((res) => res.json())
        .then((data) => {
          setIsDockerActive(data.active);
          setDockerHost(data.host || "");
          if (data.active) {
            setIsDockerStarting(false);
          }
        })
        .catch((err) => console.error("Failed to fetch Docker status:", err));
    };

    checkDockerStatus();
    const interval = setInterval(checkDockerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Docker Desktop 앱 강제 기동 요청 핸들러
  const handleStartDocker = () => {
    setIsDockerStarting(true);
    fetch("http://localhost:3001/api/docker/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          let attempts = 0;
          const interval = setInterval(() => {
            fetch("http://localhost:3001/api/docker/status")
              .then((res) => res.json())
              .then((statusData) => {
                attempts++;
                if (statusData.active) {
                  setIsDockerActive(true);
                  setDockerHost(statusData.host || "");
                  setIsDockerStarting(false);
                  clearInterval(interval);
                } else if (attempts > 30) {
                  setIsDockerStarting(false);
                  clearInterval(interval);
                  alert(
                    "Docker Desktop boot timeout. Please check Docker Desktop application manually.",
                  );
                }
              })
              .catch(() => clearInterval(interval));
          }, 1000);
        } else {
          setIsDockerStarting(false);
          alert(data.error || "Failed to start Docker Desktop.");
        }
      })
      .catch((err) => {
        setIsDockerStarting(false);
        alert("Failed to send Docker start request.");
      });
  };

  // 사이드바 가로 리사이징 핸들러 (마우스 드래그 추적)
  const startResizeSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingSidebar(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingSidebar) return;
      const newWidth = Math.max(300, Math.min(e.clientX, 650));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
    };

    if (isResizingSidebar) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingSidebar]);

  // 하단 로그 패널 세로 리사이징 핸들러
  const startResizeLog = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingLog(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingLog) return;
      const newHeight = Math.max(
        150,
        Math.min(window.innerHeight - e.clientY, 600),
      );
      setLogPanelHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizingLog(false);
    };

    if (isResizingLog) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingLog]);

  // 좌측 사이드바 내부 수평 섹션 1 (워크플로우 영역) 세로 높이 조절
  const startResizeWorkflow = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = workflowHeight;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const next = Math.max(48, startH + deltaY);
      setWorkflowHeight(next);
      setWorkflowCollapsed(next <= 48);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // 좌측 사이드바 내부 수평 섹션 2 (실행 상세 정보 영역) 세로 높이 조절
  const startResizeDetail = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = detailHeight;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const next = Math.max(48, startH + deltaY);
      setDetailHeight(next);
      setDetailCollapsed(next <= 48);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // 좌측 사이드바 내부 수평 섹션 3 (Jobs & Steps 영역) 세로 높이 조절
  const startResizeJobs = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = jobsHeight;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const next = Math.max(48, startH + deltaY);
      setJobsHeight(next);
      setJobsCollapsed(next <= 48);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // 현재 연결 정보 로드
  useEffect(() => {
    fetch("http://localhost:3001/api/workspace")
      .then((res) => res.json())
      .then((data) => {
        if (data.targetWorkspacePath) {
          setWorkspacePath(data.targetWorkspacePath);
          setIsConnected(true);
          loadWorkflows();
        }
      })
      .catch((err) => console.error("Failed to load workspace path:", err));
  }, []);

  const loadWorkflows = () => {
    fetch("http://localhost:3001/api/workflows")
      .then((res) => res.json())
      .then((data) => {
        setWorkflows(data);
        if (data.length > 0) {
          setSelectedWorkflowFile(data[0]);
          setViewMode("workflow");
        }
      })
      .catch((err) => console.error("Failed to fetch workflows:", err));
  };

  const loadWorkflowHistory = (file: string) => {
    if (!file) return;
    fetch(`http://localhost:3001/api/history?file=${file}`)
      .then((res) => res.json())
      .then((data) => setWorkflowHistory(data))
      .catch((err) => console.error("Failed to fetch workflow history:", err));
  };

  // 선택된 워크플로우의 실행 이력 로드
  useEffect(() => {
    selectedWorkflowFileRef.current = selectedWorkflowFile;
    loadWorkflowHistory(selectedWorkflowFile);
  }, [selectedWorkflowFile]);

  // WebSocket 연결 구성
  useEffect(() => {
    function connect() {
      const socket = new WebSocket("ws://localhost:3001");
      wsRef.current = socket;

      socket.onopen = () => {
        console.log("[WS] Connected to monitoring backend");
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.event === "session_sync") {
          const session = data.session as BuildSession;
          setSessions((prev) => ({
            ...prev,
            [session.sessionId]: session,
          }));
          setSelectedSessionId((curr) => curr || session.sessionId);
          setViewMode("session");
          if (
            session.status === "completed" &&
            session.workflowFile &&
            session.workflowFile === selectedWorkflowFileRef.current
          ) {
            loadWorkflowHistory(session.workflowFile);
          }
        } else if (data.event === "docker_cleanup") {
          const payload = data.payload;
          setDiagSteps((prev) => ({
            ...prev,
            step5: {
              status: payload.status === "success" ? "success" : "failure",
              message: payload.message,
            },
          }));
        } else {
          const socketEvent = data as SocketEvent;
          const { sessionId } = socketEvent;

          // 실시간 경고/에러 어노테이션 파싱
          if (socketEvent.event === "log_emitted") {
            const logLine = socketEvent.payload.log;
            let type: "error" | "warning" | null = null;

            // 'pull access denied for ubuntu-latest' 감지 시 해결 가이드 모달 띄우기
            if (
              logLine.includes("pull access denied for ubuntu-latest") ||
              logLine.includes(
                "repository does not exist or may require 'docker login'",
              )
            ) {
              setDiagModalTitle("도커 이미지 다운로드 실패: ubuntu-latest");
              setDiagModalError(logLine);
              setDiagModalGuide(
                <div className="space-y-3 text-slate-300 text-sm mt-3.5 leading-relaxed">
                  <p>
                    GitHub Actions의 공식 실행기 명칭인{" "}
                    <strong>ubuntu-latest</strong>는 실제 Docker Hub상에
                    물리적인 이미지로 존재하지 않기 때문에 발생하는 충돌
                    현상입니다.
                  </p>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2.5">
                    <p className="font-bold text-cyan-400">
                      💡 해결 가이드라인:
                    </p>
                    <p>
                      현재 백엔드 에뮬레이터에서 자동으로 이미지 매핑 플래그를
                      추가하도록 패치되었습니다. 하지만 수동으로 이 에러를 지속
                      방지하고 싶다면 아래 조치를 취할 수 있습니다:
                    </p>
                    <ul className="list-disc pl-4 space-y-2">
                      <li>
                        <strong>방법 1 (로컬 act 설정 파일 구성):</strong>{" "}
                        프로젝트 폴더 루트 디렉토리에 <code>.actrc</code> 파일을
                        생성하시고 아래 맵 라인을 복사하여 추가해 주세요:
                        <pre className="bg-black text-rose-455 p-2.5 rounded font-mono mt-1.5 select-all border border-slate-850">
                          -P ubuntu-latest=catthehacker/ubuntu:act-latest
                        </pre>
                      </li>
                      <li>
                        <strong>방법 2 (Docker Hub 로그인 확인):</strong> 간혹
                        도커 허브 다운로드 할당량 초과(Rate limit)로 인해 발생할
                        수 있습니다. 터미널에서 다음을 실행해 도커 계정으로
                        로그인해 주십시오:
                        <pre className="bg-black text-rose-455 p-2.5 rounded font-mono mt-1.5 select-all border border-slate-850">
                          docker login
                        </pre>
                      </li>
                    </ul>
                  </div>
                </div>,
              );
              setIsDiagModalOpen(true);
            }

            // Non-terminating git clone 경고 등 불필요한 빌드 보조 메시지는 어노테이션 경보에서 제외
            const isNonTerminatingGitError =
              logLine.includes("Non-terminating error") ||
              logLine.includes("some refs were not updated");

            if (!isNonTerminatingGitError) {
              if (
                logLine.toLowerCase().includes("error") ||
                logLine.includes("❌") ||
                logLine.includes("Error:")
              ) {
                type = "error";
              } else if (
                logLine.toLowerCase().includes("warning") ||
                logLine.includes("⚠️") ||
                logLine.includes("Warning:")
              ) {
                type = "warning";
              }
            }

            if (type) {
              setAnnotations((prev) => {
                const sessionAnn = prev[sessionId] || [];
                if (sessionAnn.some((a) => a.message === logLine)) return prev;
                return {
                  ...prev,
                  [sessionId]: [
                    ...sessionAnn,
                    {
                      type: type!,
                      message: logLine,
                      timestamp: socketEvent.timestamp,
                      jobId: socketEvent.payload.jobId,
                      stepName:
                        currentStepByJobRef.current[socketEvent.payload.jobId],
                    },
                  ],
                };
              });
            } else if (!/^[🐳⭐✅❌🏁☁❓⚙🚀]/.test(logLine)) {
              // act 표준 아이콘 라인이 아니면 직전 어노테이션(같은 job)의 상세 내용으로 이어붙임
              setAnnotations((prev) => {
                const sessionAnn = prev[sessionId] || [];
                const last = sessionAnn[sessionAnn.length - 1];
                if (!last || last.jobId !== socketEvent.payload.jobId)
                  return prev;
                const updated = [...sessionAnn];
                updated[updated.length - 1] = {
                  ...last,
                  message: `${last.message}\n${logLine}`,
                };
                return { ...prev, [sessionId]: updated };
              });
            }
          }

          setSessions((prev) => {
            const currentSession = prev[sessionId] || {
              sessionId,
              createdAt: socketEvent.timestamp,
              status: "running",
              jobs: {},
            };

            const updatedSession = { ...currentSession };

            if (socketEvent.event === "session_created") {
              updatedSession.status = "running";
              setSelectedSessionId(sessionId);
              setViewMode("session");
              setAnnotations((prev) => ({ ...prev, [sessionId]: [] }));
            } else if (socketEvent.event === "job_status") {
              const { jobId, workflow, status } = socketEvent.payload;
              updatedSession.jobs[jobId] = updatedSession.jobs[jobId] || {
                jobId,
                workflow,
                status,
                steps: [],
                logs: [],
              };
              updatedSession.jobs[jobId].status = status;
              // ponytail: 사용자가 이미 다른 Job을 보고 있다면 뺏지 않고, 아직 아무것도 선택 안 됐을 때만 자동 포커스
              setSelectedJobId((curr) => curr || jobId);

              setTimeout(() => {
                jobElementsRef.current[jobId]?.scrollIntoView({
                  behavior: "smooth",
                  block: "nearest",
                });
              }, 100);
            } else if (socketEvent.event === "step_status") {
              const { jobId, stepName, status } = socketEvent.payload;
              if (status === "running") {
                currentStepByJobRef.current[jobId] = stepName;
              }
              const job = updatedSession.jobs[jobId] || {
                jobId,
                workflow: "Workflow",
                status: "running",
                steps: [],
                logs: [],
              };
              updatedSession.jobs[jobId] = job;

              const stepIndex = job.steps.findIndex((s) => s.name === stepName);
              if (stepIndex === -1) {
                job.steps.push({
                  name: stepName,
                  status,
                  startedAt: new Date().toISOString(),
                });
              } else {
                const step = job.steps[stepIndex];
                step.status = status;
                if (status === "running") {
                  step.startedAt = new Date().toISOString();
                } else if (status === "success" || status === "failure") {
                  step.completedAt = new Date().toISOString();
                }
              }
            } else if (socketEvent.event === "log_emitted") {
              const { jobId, log } = socketEvent.payload;
              const job = updatedSession.jobs[jobId] || {
                jobId,
                workflow: "Workflow",
                status: "running",
                steps: [],
                logs: [],
              };
              updatedSession.jobs[jobId] = job;
              job.logs.push(log);
            }

            return {
              ...prev,
              [sessionId]: updatedSession,
            };
          });
        }
      };

      socket.onclose = () => {
        console.log("[WS] Disconnected. Reconnecting in 3s...");
        setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // 선택된 YAML 파일 로드
  useEffect(() => {
    if (selectedWorkflowFile) {
      fetch(`http://localhost:3001/api/workflows?file=${selectedWorkflowFile}`)
        .then((res) => res.text())
        .then((text) => setWorkflowContent(text))
        .catch((err) => console.error("Failed to fetch workflow yml:", err));
    }
  }, [selectedWorkflowFile]);

  // 로그 스크롤 (사용자가 맨 아래 근처에 있을 때만 자동 스크롤)
  useEffect(() => {
    const container = logEndRef.current?.parentElement;
    if (!container) return;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      100;
    if (isNearBottom) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [sessions, selectedSessionId, selectedJobId, viewMode, tick]);

  // 워크플로우 지정 실행 트리거 (도커 정밀 가드 및 에러 대처 모달 연동)
  const triggerWorkflowRun = async (file: string, jobId?: string) => {
    setSelectedWorkflowFile(file);
    setDiagSteps({
      step1: { status: "running", message: "Docker CLI 설치 확인 중..." },
      step2: { status: "idle", message: "" },
      step3: { status: "idle", message: "" },
      step4: { status: "idle", message: "" },
      step5: { status: "idle", message: "" },
    });

    try {
      const diagRes = await fetch(
        "http://localhost:3001/api/docker/diagnostic",
      );
      const diagData = await diagRes.json();

      // 1단계 실패 시 ➡️ CLI 미설치 모달 호출
      if (diagData.step1.status === "failure") {
        setDiagSteps({
          step1: { status: "failure", message: diagData.step1.message },
          step2: { status: "idle", message: "" },
          step3: { status: "idle", message: "" },
          step4: { status: "idle", message: "" },
          step5: { status: "idle", message: "" },
        });

        setDiagModalTitle(
          "도커 진단 실패: Docker CLI가 설치되어 있지 않습니다.",
        );
        setDiagModalError(diagData.step1.message);
        setDiagModalGuide(
          <div className="space-y-3 text-slate-300 text-sm mt-3.5 leading-relaxed">
            <p>
              로컬 PC 가상 컨테이너에서 깨끗하고 독립된 빌드 환경을 구축하기
              위해선 <strong>Docker</strong>가 시스템에 필수 설치되어 있어야
              합니다.
            </p>
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2.5">
              <p className="font-bold text-cyan-400">💡 해결 가이드라인:</p>
              <ul className="list-disc pl-4 space-y-2">
                <li>
                  공식 홈페이지인{" "}
                  <a
                    href="https://www.docker.com/products/docker-desktop/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline font-bold"
                  >
                    Docker Desktop 다운로드
                  </a>
                  에 접속하여 설치 패키지를 다운로드한 뒤 실행해 주세요.
                </li>
              </ul>
            </div>
          </div>,
        );
        setIsDiagModalOpen(true);
        return;
      }

      // 2단계 실패 시 ➡️ 데몬 오프라인 모달 호출
      if (diagData.step2.status === "failure") {
        setDiagSteps({
          step1: { status: "success", message: diagData.step1.message },
          step2: { status: "failure", message: diagData.step2.message },
          step3: { status: "idle", message: "" },
          step4: { status: "idle", message: "" },
          step5: { status: "idle", message: "" },
        });

        setDiagModalTitle(
          "도커 진단 실패: Docker 데몬 소켓을 찾을 수 없습니다.",
        );
        setDiagModalError(diagData.step2.message);
        setDiagModalGuide(
          <div className="space-y-3 text-slate-300 text-sm mt-3.5 leading-relaxed">
            <p>
              Docker는 설치되어 있으나, 백그라운드 엔진인{" "}
              <strong>
                Docker 데몬(소켓 서비스)이 현재 완전히 꺼져 있는 상태
              </strong>
              입니다.
            </p>
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2.5">
              <p className="font-bold text-cyan-400">💡 해결 가이드라인:</p>
              <ul className="list-disc pl-4 space-y-2">
                <li>
                  <strong>해결책 1 (원클릭 부팅):</strong> 대시보드 우측 상단
                  헤더 영역의 <strong>`[엔진 켜기]`</strong> 버튼을 눌러 데몬
                  가동을 시작해 보세요.
                </li>
                <li>
                  <strong>해결책 2 (수동 기동):</strong> macOS 어플리케이션
                  폴더의 <strong>Docker Desktop</strong> 앱을 클릭해 켜주시고,
                  고래 아이콘이 완전히 <strong>초록색(Engine Running)</strong>이
                  될 때까지 기다립니다.
                </li>
              </ul>
            </div>
          </div>,
        );
        setIsDiagModalOpen(true);
        return;
      }

      // 3단계 실패 시 ➡️ 권한 에러 모달 호출
      if (diagData.step3.status === "failure") {
        setDiagSteps({
          step1: { status: "success", message: diagData.step1.message },
          step2: { status: "success", message: diagData.step2.message },
          step3: { status: "failure", message: diagData.step3.message },
          step4: { status: "idle", message: "" },
          step5: { status: "idle", message: "" },
        });

        setDiagModalTitle(
          "도커 진단 실패: Docker 데몬 연결 권한이 없거나 반응이 없습니다.",
        );
        setDiagModalError(diagData.step3.message);
        setDiagModalGuide(
          <div className="space-y-3 text-slate-300 text-sm mt-3.5 leading-relaxed">
            <p>
              Docker 서비스 소켓 파일은 존재하지만, 시스템 보안이나
              권한(Permission) 문제로 인해 **현재 에이전트 프로세스가 소켓에
              연결할 수 없습니다.**
            </p>
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2.5">
              <p className="font-bold text-cyan-400">💡 해결 가이드라인:</p>
              <ul className="list-disc pl-4 space-y-2">
                <li>
                  <strong>방법 1 (소켓 권한 공유):</strong> Docker Desktop
                  설정(Settings) ➡️ `Advanced` 메뉴로 들어가서{" "}
                  <strong>
                    `System-wide socket (Allow default Docker socket...)`
                  </strong>{" "}
                  옵션이 켜져 있는지 확인하고 승인해 주세요.
                </li>
                <li>
                  <strong>방법 2 (소켓 파일 소유권 수동 설정):</strong> 터미널을
                  열고 아래 소켓 권한 허용 명령어를 입력하여 권한을
                  풀어주십시오:
                  <pre className="bg-black text-rose-400 p-2.5 rounded font-mono mt-1.5 select-all border border-slate-850">
                    sudo chmod 666 /var/run/docker.sock
                  </pre>
                </li>
              </ul>
            </div>
          </div>,
        );
        setIsDiagModalOpen(true);
        return;
      }

      // 통과 ➡️ 4단계 실행
      setDiagSteps({
        step1: { status: "success", message: diagData.step1.message },
        step2: { status: "success", message: diagData.step2.message },
        step3: { status: "success", message: diagData.step3.message },
        step4: {
          status: "running",
          message: "GitHub Actions 워크플로우 시뮬레이션 가동 중...",
        },
        step5: { status: "idle", message: "" },
      });

      const workflowPath = `.github/workflows/${file}`;
      const args = jobId
        ? ["-W", workflowPath, "-j", jobId]
        : ["-W", workflowPath];
      const triggerRes = await fetch("http://localhost:3001/api/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args,
          workflowFile: file,
        }),
      });
      const triggerData = await triggerRes.json();

      if (triggerData.success) {
        if (triggerData.sessionId) {
          setSelectedSessionId(triggerData.sessionId);
        }
        setViewMode("session");
        setDiagSteps((prev) => ({
          ...prev,
          step4: {
            status: "success",
            message: "워크플로우 성공적으로 기동 완료",
          },
          step5: {
            status: "running",
            message: "빌드 완료 후 리소스 정리 대기 중...",
          },
        }));
      } else {
        setDiagSteps((prev) => ({
          ...prev,
          step4: {
            status: "failure",
            message: triggerData.error || "워크플로우 실행 중 실패 발생",
          },
        }));
      }
    } catch (err) {
      setDiagSteps((prev) => ({
        ...prev,
        step1: {
          status: "failure",
          message: "에이전트 서버 통신 실패 (백엔드가 오프라인 상태)",
        },
      }));
      setDiagModalTitle("에이전트 통신 오류");
      setDiagModalError(
        "로컬 백엔드 서버(agent.ts)와 웹소켓/API 통신이 원활하지 않습니다.",
      );
      setDiagModalGuide(
        <div className="space-y-3 text-slate-300 text-sm mt-3">
          <p>
            로컬 모니터링 허브가 꺼져 있어 상태 데이터를 읽어올 수 없습니다.
          </p>
          <p className="font-bold text-cyan-400">💡 해결 방법:</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>
              프로젝트 터미널로 돌아가 백엔드 서버인{" "}
              <code className="bg-black px-1 py-0.5 rounded text-rose-455 font-mono">
                npm run agent
              </code>{" "}
              명령어를 재기동해 주세요.
            </li>
          </ul>
        </div>,
      );
      setIsDiagModalOpen(true);
    }
  };

  // 폴더 선택 팝업 핸들러
  const handleSelectWorkspace = (event: React.MouseEvent) => {
    event.preventDefault();

    fetch("http://localhost:3001/api/workspace/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.targetWorkspacePath) {
          setWorkspacePath(data.targetWorkspacePath);
          setIsConnected(true);
          loadWorkflows();
        }
      })
      .catch((err) => {
        alert("Failed to connect workspace. Ensure backend server is active.");
      });
  };

  // 실행 중인 세션 중단 핸들러
  const handleCancelSession = (sessionId: string) => {
    fetch("http://localhost:3001/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          alert("Build session cancellation request sent.");
        } else {
          alert(`Failed to cancel: ${data.error}`);
        }
      })
      .catch((err) => alert("Failed to request cancellation."));
  };

  const currentSession = selectedSessionId ? sessions[selectedSessionId] : null;
  const currentJob =
    currentSession && selectedJobId ? currentSession.jobs[selectedJobId] : null;
  const currentJobAnnotations =
    selectedSessionId && selectedJobId
      ? (annotations[selectedSessionId] || []).filter(
          (a) => a.jobId === selectedJobId,
        )
      : [];
  const annotationErrorCount = currentJobAnnotations.filter(
    (a) => a.type === "error",
  ).length;
  const annotationWarningCount = currentJobAnnotations.filter(
    (a) => a.type === "warning",
  ).length;
  const currentSessionAnnotations = currentJobAnnotations.filter(
    (a) =>
      (!annotationFilter || a.type === annotationFilter) &&
      (!annotationStepFilter || a.stepName === annotationStepFilter),
  );

  // 경과 시간 계산 유틸리티
  const calculateDuration = (started?: string, completed?: string): string => {
    if (!started) return "-";
    const start = new Date(started).getTime();
    const end = completed ? new Date(completed).getTime() : Date.now();
    const diff = Math.max(0, end - start);

    const secs = Math.floor(diff / 1000) % 60;
    const mins = Math.floor(diff / 60000) % 60;
    const hrs = Math.floor(diff / 3600000);

    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  // YAML에 선언된 모든 Job 정보 추출
  let yamlJobs: Record<
    string,
    { name?: string; needs?: string | string[]; steps?: any[] }
  > = {};
  try {
    if (workflowContent) {
      const parsed = yaml.parse(workflowContent);
      if (parsed && parsed.jobs) {
        yamlJobs = parsed.jobs;
      }
    }
  } catch (e) {}

  // React Flow 노드 클릭 이벤트 연결
  const onNodeClick = (event: React.MouseEvent, node: Node) => {
    const jobId = node.id;
    const sessionJobId = yamlJobs[jobId]?.name || jobId;
    setSelectedJobId(sessionJobId);
    setAnnotationStepFilter(null);

    if (currentSession && currentSession.jobs[sessionJobId]) {
      setViewMode("session");
    }

    setTimeout(() => {
      jobElementsRef.current[sessionJobId]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }, 50);
  };

  // React Flow 데이터 구성
  let flowNodes: Node[] = [];
  let flowEdges: Edge[] = [];

  if (viewMode === "session" && currentSession) {
    let baseNodes: Node[] = [];
    let baseEdges: Edge[] = [];

    if (workflowContent) {
      const parsed = parseWorkflowYaml(workflowContent);
      baseNodes = parsed.nodes.map((n) => ({ ...n }));
      baseEdges = parsed.edges.map((e) => ({ ...e }));
    }

    if (baseNodes.length > 0) {
      flowNodes = baseNodes.map((node) => {
        const jobId = node.id;
        const sessionJobId = yamlJobs[jobId]?.name || jobId;
        const sessionJob = currentSession.jobs[sessionJobId];
        const status = sessionJob ? sessionJob.status : "pending";
        const isFocused = selectedJobId === sessionJobId;

        return {
          ...node,
          data: {
            label: `${jobId} (${status})${
              status !== "pending"
                ? ` - ${calculateDuration(sessionJob?.startedAt, sessionJob?.completedAt)}`
                : ""
            }`,
          },
          style: {
            background:
              status === "success"
                ? "#10B981"
                : status === "failure"
                  ? "#EF4444"
                  : status === "running"
                    ? "#3B82F6"
                    : "#1F2937",
            color: "#fff",
            borderRadius: "8px",
            border: isFocused
              ? "3px solid #06B6D4"
              : status === "running"
                ? "2px solid #3B82F6"
                : "1px solid rgba(255,255,255,0.1)",
            boxShadow: isFocused
              ? "0 0 15px rgba(6, 182, 212, 0.4)"
              : "0 4px 6px -1px rgba(0,0,0,0.1)",
            padding: "12px 18px",
            fontWeight: "bold",
            fontSize: "14px",
            cursor: "pointer",
          },
        };
      });

      flowEdges = baseEdges.map((edge) => {
        const sourceJobStatus = currentSession.jobs[edge.source]?.status;
        const targetJobStatus = currentSession.jobs[edge.target]?.status;

        return {
          ...edge,
          animated:
            sourceJobStatus === "running" || targetJobStatus === "running",
          style: {
            stroke: sourceJobStatus === "success" ? "#10B981" : "#4B5563",
            strokeWidth: 2,
          },
        };
      });
    }
  } else if (viewMode === "workflow" && workflowContent) {
    const { nodes, edges } = parseWorkflowYaml(workflowContent);
    flowNodes = nodes.map((n) => {
      const isFocused = selectedJobId === n.id;
      return {
        ...n,
        style: {
          background: "#1F2937",
          color: "#F3F4F6",
          borderRadius: "8px",
          border: isFocused
            ? "3px solid #06B6D4"
            : "1px solid rgba(255,255,255,0.1)",
          boxShadow: isFocused ? "0 0 12px rgba(6, 182, 212, 0.3)" : "none",
          padding: "12px 18px",
          fontWeight: "semibold",
          fontSize: "14px",
          cursor: "pointer",
        },
      };
    });
    flowEdges = edges.map((e) => ({
      ...e,
      style: { stroke: "#4B5563", strokeWidth: 2 },
    }));
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* 상단 헤더 */}
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/50 px-6 py-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <svg
            className="h-6 w-6 text-emerald-500 fill-current animate-pulse"
            viewBox="0 0 24 24"
          >
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.137 20.162 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
          </svg>
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
            GitHub Actions Local Visualizer
          </h1>
        </div>

        {/* 프로젝트 디렉토리 선택 */}
        <div className="flex items-center gap-3 bg-slate-950 px-4 py-2 rounded-lg border border-slate-800 max-w-2xl w-full">
          <span className="text-xs text-slate-400 font-bold uppercase tracking-wider whitespace-nowrap">
            Target Project:
          </span>
          <span
            className="text-sm text-slate-200 font-mono truncate flex-1 block"
            title={workspacePath || "연결된 폴더 없음"}
          >
            {workspacePath || "연결된 폴더가 없습니다."}
          </span>
          <button
            onClick={handleSelectWorkspace}
            className="bg-blue-655 hover:bg-blue-500 text-white text-sm font-semibold px-3 py-1.5 rounded transition whitespace-nowrap"
          >
            폴더 선택...
          </button>
        </div>

        {/* Docker 상태 제어기 */}
        <div className="flex items-center gap-2.5 bg-slate-950 px-3.5 py-2 rounded-lg border border-slate-800 transition">
          <span className="text-xs text-slate-400 font-bold uppercase tracking-wider whitespace-nowrap">
            Docker Daemon:
          </span>
          {isDockerActive ? (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wide">
                ACTIVE 🟢
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-rose-500 animate-ping absolute" />
                <span className="h-2 w-2 rounded-full bg-rose-500 relative" />
                <span className="text-xs font-bold text-rose-400 uppercase tracking-wide">
                  INACTIVE ❌
                </span>
              </div>
              {isDockerStarting ? (
                <span className="text-xs text-cyan-400 animate-pulse font-medium whitespace-nowrap ml-1 font-mono">
                  ⏳ 켜는 중...
                </span>
              ) : (
                <button
                  onClick={handleStartDocker}
                  className="bg-slate-900 hover:bg-slate-800 text-cyan-400 hover:text-cyan-300 text-xs font-bold px-2 py-1.5 rounded border border-slate-800 hover:border-cyan-500/30 transition shadow-md shadow-black/40"
                >
                  엔진 켜기
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* 본문 통합 본체 */}
      <div className="flex flex-1 overflow-hidden relative min-h-0">
        {/* 좌측 단일 통합 컨트롤 패널 (가로 폭 조절 가능) */}
        <aside
          style={{ width: `${sidebarWidth}px` }}
          className="border-r border-slate-800 bg-slate-900/30 backdrop-blur-sm flex flex-col overflow-y-auto relative h-full flex-shrink-0"
        >
          {/* 섹션 1: 워크플로우 선택 및 실행 */}
          <div
            style={{
              height: workflowCollapsed ? "48px" : `${workflowHeight}px`,
            }}
            className="p-4 flex flex-col overflow-hidden flex-shrink-0 relative"
          >
            <h2
              onClick={() => setWorkflowCollapsed((c) => !c)}
              className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center justify-between cursor-pointer select-none"
            >
              <span className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">
                  {workflowCollapsed ? "▶" : "▼"}
                </span>
                워크플로우 선택 (YAML)
              </span>
              <span className="text-xs px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded font-mono">
                {workflows.length}
              </span>
            </h2>
            {!workflowCollapsed && (
              <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                {workflows.length === 0 ? (
                  <div className="text-sm text-slate-500 text-center py-6">
                    연동된 폴더가 없거나
                    <br />
                    YAML 파일이 없습니다.
                  </div>
                ) : (
                  workflows.map((file) => (
                    <div
                      key={file}
                      className={`p-3 rounded-lg border group transition-all cursor-pointer relative ${
                        selectedWorkflowFile === file && viewMode === "workflow"
                          ? "bg-slate-800/60 border-cyan-500/50 shadow-md shadow-cyan-950/20"
                          : "bg-slate-900/40 border-slate-850 hover:bg-slate-800/20"
                      }`}
                      onClick={() => {
                        setSelectedWorkflowFile(file);
                        setViewMode("workflow");
                        setSelectedJobId(null);
                        setAnnotationStepFilter(null);
                      }}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 text-slate-400">
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                            />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-200 truncate group-hover:text-cyan-400 transition">
                            {file}
                          </p>
                          <span className="text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono mt-1.5 inline-block">
                            on: push
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          triggerWorkflowRun(file);
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-2.5 py-1.5 rounded font-bold transition-all shadow-md shadow-emerald-950/50"
                      >
                        실행
                      </button>
                    </div>
                  ))
                )}

                {workflowHistory.length > 0 && (
                  <div className="pt-2 mt-1 border-t border-slate-850 space-y-1.5">
                    <p className="text-xs text-slate-500 font-bold uppercase tracking-wider px-0.5">
                      최근 실행 이력
                    </p>
                    {workflowHistory.map((histSession) => {
                      const jobs = Object.values(histSession.jobs);
                      const hasFailure = jobs.some(
                        (j) => j.status === "failure",
                      );
                      return (
                        <div
                          key={histSession.sessionId}
                          onClick={() => {
                            setSessions((prev) => ({
                              ...prev,
                              [histSession.sessionId]: histSession,
                            }));
                            setSelectedSessionId(histSession.sessionId);
                            setSelectedJobId(null);
                            setAnnotationStepFilter(null);
                            setViewMode("session");
                          }}
                          className={`p-2 rounded-lg border cursor-pointer transition flex items-center justify-between ${
                            selectedSessionId === histSession.sessionId
                              ? "bg-slate-800/60 border-cyan-500/50"
                              : "bg-slate-900/30 border-slate-850 hover:bg-slate-800/20"
                          }`}
                        >
                          <span className="flex items-center gap-1.5 text-xs">
                            <span>{hasFailure ? "🔴" : "🟢"}</span>
                            <span className="text-slate-300 font-mono">
                              {new Date(histSession.createdAt).toLocaleString()}
                            </span>
                          </span>
                          <span className="text-xs text-emerald-400 font-mono">
                            {calculateDuration(
                              histSession.createdAt,
                              histSession.completedAt,
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 수평 리사이즈 바 1 */}
          <div
            onMouseDown={startResizeWorkflow}
            className="h-1.5 w-full bg-slate-800/80 cursor-row-resize hover:bg-cyan-500/80 active:bg-cyan-500 transition-all z-10 flex-shrink-0"
          />

          {/* 섹션 2: 실행 상세 정보 */}
          <div
            style={{ height: detailCollapsed ? "48px" : `${detailHeight}px` }}
            className="p-4 overflow-hidden flex-shrink-0"
          >
            <h3
              onClick={() => setDetailCollapsed((c) => !c)}
              className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3 cursor-pointer select-none flex items-center gap-1.5"
            >
              <span className="text-xs text-slate-500">
                {detailCollapsed ? "▶" : "▼"}
              </span>
              실행 상세 정보
            </h3>
            {!detailCollapsed &&
              (currentSession ? (
                <div className="space-y-2 bg-slate-950/40 p-3 rounded-lg border border-slate-850 overflow-y-auto max-h-[85%]">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">상태</span>
                    <span
                      className={`font-semibold ${currentSession.status === "running" ? "text-blue-400 animate-pulse" : "text-slate-300"}`}
                    >
                      {currentSession.status === "running"
                        ? "실행 중"
                        : "완료됨"}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">시작 시각</span>
                    <span className="text-slate-200 font-mono">
                      {new Date(currentSession.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">총 경과 시간</span>
                    <span className="text-emerald-400 font-bold font-mono">
                      {calculateDuration(
                        currentSession.createdAt,
                        currentSession.completedAt,
                      )}
                    </span>
                  </div>
                  {currentSession.status === "running" && (
                    <button
                      onClick={() =>
                        handleCancelSession(currentSession.sessionId)
                      }
                      className="w-full mt-3 bg-rose-900/60 hover:bg-rose-800 text-rose-100 text-sm font-semibold py-2 rounded-lg border border-rose-700/50 transition"
                    >
                      빌드 중단 (Cancel Run)
                    </button>
                  )}
                </div>
              ) : (
                <div className="text-sm text-slate-500 text-center py-4 bg-slate-950/10 rounded-lg border border-dashed border-slate-850">
                  워크플로우를 실행하면 최신 세션 정보가 활성화됩니다.
                </div>
              ))}
          </div>

          {/* 수평 리사이즈 바 2 */}
          <div
            onMouseDown={startResizeDetail}
            className="h-1.5 w-full bg-slate-800/80 cursor-row-resize hover:bg-cyan-500/80 active:bg-cyan-500 transition-all z-10 flex-shrink-0"
          />

          {/* 섹션 3: Jobs & Steps 리스트 */}
          <div
            style={{ height: jobsCollapsed ? "48px" : `${jobsHeight}px` }}
            className="p-4 flex flex-col overflow-hidden flex-shrink-0 relative"
          >
            <h3
              onClick={() => setJobsCollapsed((c) => !c)}
              className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3 cursor-pointer select-none flex items-center gap-1.5"
            >
              <span className="text-xs text-slate-500">
                {jobsCollapsed ? "▶" : "▼"}
              </span>
              Jobs & Steps 리스트
            </h3>
            {!jobsCollapsed && (
              <div className="flex-1 overflow-y-auto space-y-3.5 pr-1">
                {Object.keys(yamlJobs).length > 0 ? (
                  Object.keys(yamlJobs).map((jobId) => {
                    const yamlJob = yamlJobs[jobId];
                    const sessionJobId = yamlJob.name || jobId;
                    const sessionJob = currentSession?.jobs[sessionJobId];
                    const jobStatus = sessionJob
                      ? sessionJob.status
                      : "pending";

                    const stepsToRender: BuildStep[] =
                      sessionJob && sessionJob.steps.length > 0
                        ? sessionJob.steps
                        : (yamlJob.steps || []).map((s: any) => ({
                            name: s.name || s.run || s.uses || "Step",
                            status: "pending" as const,
                            startedAt: undefined,
                            completedAt: undefined,
                          }));

                    const isSelected = selectedJobId === sessionJobId;

                    return (
                      <div
                        key={jobId}
                        ref={(el) => {
                          jobElementsRef.current[sessionJobId] = el;
                        }}
                        className={`border rounded-lg overflow-hidden bg-slate-950/20 transition-all ${
                          isSelected
                            ? "border-cyan-500/80 shadow-md shadow-cyan-950/20"
                            : "border-slate-850"
                        }`}
                      >
                        <div
                          onClick={() => {
                            setSelectedJobId(isSelected ? null : sessionJobId);
                            setAnnotationStepFilter(null);
                            if (sessionJob && !isSelected) {
                              setViewMode("session");
                            }
                          }}
                          className={`group flex justify-between items-center px-3 py-2.5 cursor-pointer transition select-none relative ${
                            isSelected
                              ? "bg-cyan-950/20 text-cyan-200"
                              : "bg-slate-900/60 hover:bg-slate-800/20"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 font-mono transition-transform duration-200">
                              {isSelected ? "▼" : "▶"}
                            </span>
                            {jobStatus === "running" && (
                              <div className="h-3.5 w-3.5 rounded-full border-2 border-t-transparent border-blue-500 animate-spin" />
                            )}
                            {jobStatus === "success" && (
                              <span className="text-emerald-500 text-sm">
                                🟢
                              </span>
                            )}
                            {jobStatus === "failure" && (
                              <span className="text-rose-500 text-sm">🔴</span>
                            )}
                            {jobStatus === "pending" && (
                              <span className="text-slate-555 text-sm">⚪</span>
                            )}
                            <span
                              className={`text-sm font-bold ${isSelected ? "text-cyan-400" : "text-slate-100"}`}
                            >
                              {yamlJob.name || jobId}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs font-mono text-slate-400">
                            {jobStatus !== "running" && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  triggerWorkflowRun(selectedWorkflowFile, jobId);
                                }}
                                title={`${jobId}만 실행`}
                                className="opacity-0 group-hover:opacity-100 bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-2 py-1 rounded font-bold transition-all shadow-md shadow-emerald-950/50"
                              >
                                실행
                              </button>
                            )}
                            {jobStatus !== "pending" && (
                              <span className="text-emerald-400 font-semibold mr-1">
                                {calculateDuration(
                                  sessionJob?.startedAt,
                                  sessionJob?.completedAt,
                                )}
                              </span>
                            )}
                            <span
                              className={
                                jobStatus === "pending"
                                  ? "text-slate-550"
                                  : "text-slate-350"
                              }
                            >
                              {jobStatus === "pending"
                                ? "Pending"
                                : jobStatus === "running"
                                  ? "Running"
                                  : "Finished"}
                            </span>
                          </div>
                        </div>

                        {isSelected && (
                          <div className="divide-y divide-slate-850 bg-slate-950/40 transition-all duration-300 animate-fade-in">
                            {stepsToRender.length === 0 ? (
                              <div className="text-sm text-slate-500 px-4 py-2 flex items-center gap-2">
                                <span className="animate-pulse">◦</span>
                                <span>단계가 없습니다.</span>
                              </div>
                            ) : (
                              stepsToRender.map((step, idx) => (
                                <div
                                  key={idx}
                                  ref={(el) => {
                                    stepElementsRef.current[
                                      `${sessionJobId}::${step.name}`
                                    ] = el;
                                  }}
                                  onClick={() => {
                                    setSelectedJobId(sessionJobId);
                                    setAnnotationStepFilter((curr) =>
                                      curr === step.name ? null : step.name,
                                    );
                                    setTimeout(() => {
                                      const jobAnns = (
                                        (selectedSessionId &&
                                          annotations[selectedSessionId]) ||
                                        []
                                      ).filter((a) => a.jobId === sessionJobId);
                                      const targetIdx = jobAnns.findIndex(
                                        (a) => a.stepName === step.name,
                                      );
                                      if (targetIdx !== -1) {
                                        annotationElementsRef.current[
                                          targetIdx
                                        ]?.scrollIntoView({
                                          behavior: "smooth",
                                          block: "nearest",
                                        });
                                      }
                                    }, 50);
                                  }}
                                  className="flex justify-between items-center px-4 py-2 text-sm hover:bg-slate-900/30 cursor-pointer"
                                >
                                  <div className="flex items-center gap-2">
                                    {step.status === "running" && (
                                      <div className="h-2.5 w-2.5 rounded-full border border-t-transparent border-blue-400 animate-spin" />
                                    )}
                                    {step.status === "success" && (
                                      <span className="text-emerald-500">
                                        ✓
                                      </span>
                                    )}
                                    {step.status === "failure" && (
                                      <span className="text-rose-500">✗</span>
                                    )}
                                    {step.status === "pending" && (
                                      <span className="text-slate-555">◦</span>
                                    )}
                                    <span
                                      className="text-slate-300 font-medium truncate max-w-[200px]"
                                      title={step.name}
                                    >
                                      {step.name}
                                    </span>
                                  </div>
                                  <span className="text-xs text-slate-555 font-mono">
                                    {calculateDuration(
                                      step.startedAt,
                                      step.completedAt,
                                    )}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-sm text-slate-500 text-center py-8">
                    시각화할 워크플로우 Jobs가 없습니다.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 수평 리사이즈 바 3 */}
          <div
            onMouseDown={startResizeJobs}
            className="h-1.5 w-full bg-slate-800/80 cursor-row-resize hover:bg-cyan-500/80 active:bg-cyan-500 transition-all z-10 flex-shrink-0"
          />

          {/* 섹션 4: 어노테이션 */}
          <div
            style={{
              height: annotationCollapsed ? "48px" : ``,
            }}
            className="p-4 flex flex-col overflow-hidden flex-shrink-0 relative"
          >
            <h3
              onClick={() => setAnnotationCollapsed((c) => !c)}
              className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center justify-between cursor-pointer select-none"
            >
              <span className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">
                  {annotationCollapsed ? "▶" : "▼"}
                </span>
                어노테이션 (오류/경고)
              </span>
              {currentJobAnnotations.length > 0 && (
                <span className="text-xs px-1.5 py-0.5 bg-rose-950/50 text-rose-300 border border-rose-900/50 rounded font-bold font-mono animate-pulse">
                  {currentJobAnnotations.length}
                </span>
              )}
            </h3>
            {!annotationCollapsed && (
              <>
                <div className="flex gap-1.5 mb-2.5">
                  <button
                    onClick={() =>
                      setAnnotationFilter((f) =>
                        f === "error" ? null : "error",
                      )
                    }
                    className={`text-xs px-2 py-1 rounded font-bold border transition ${
                      annotationFilter === "error"
                        ? "bg-rose-950/60 border-rose-700 text-rose-300"
                        : "bg-slate-900/40 border-slate-800 text-slate-400 hover:text-rose-300"
                    }`}
                  >
                    오류 {annotationErrorCount}
                  </button>
                  <button
                    onClick={() =>
                      setAnnotationFilter((f) =>
                        f === "warning" ? null : "warning",
                      )
                    }
                    className={`text-xs px-2 py-1 rounded font-bold border transition ${
                      annotationFilter === "warning"
                        ? "bg-amber-950/60 border-amber-700 text-amber-300"
                        : "bg-slate-900/40 border-slate-800 text-slate-400 hover:text-amber-300"
                    }`}
                  >
                    경고 {annotationWarningCount}
                  </button>
                  {annotationStepFilter && (
                    <span className="text-xs px-2 py-1 rounded font-bold border border-cyan-800 bg-cyan-950/40 text-cyan-300 truncate max-w-[140px]">
                      Step: {annotationStepFilter}
                    </span>
                  )}
                  {(annotationFilter || annotationStepFilter) && (
                    <button
                      onClick={() => {
                        setAnnotationFilter(null);
                        setAnnotationStepFilter(null);
                      }}
                      className="text-xs px-2 py-1 rounded font-bold border border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200 transition"
                    >
                      필터 해제
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {currentSessionAnnotations.length === 0 ? (
                    <div className="text-sm text-slate-500 text-center py-6">
                      검출된 빌드 경고 및 에러가 없습니다.
                    </div>
                  ) : (
                    currentSessionAnnotations.map((ann, idx) => (
                      <div
                        key={idx}
                        ref={(el) => {
                          annotationElementsRef.current[idx] = el;
                        }}
                        onClick={() => {
                          setSelectedJobId(ann.jobId);
                          setTimeout(() => {
                            const stepKey = ann.stepName
                              ? `${ann.jobId}::${ann.stepName}`
                              : null;
                            const target = stepKey
                              ? stepElementsRef.current[stepKey]
                              : jobElementsRef.current[ann.jobId];
                            target?.scrollIntoView({
                              behavior: "smooth",
                              block: "nearest",
                            });
                          }, 50);
                        }}
                        className={`p-2.5 rounded-lg border text-sm leading-relaxed font-mono cursor-pointer ${
                          ann.type === "error"
                            ? "bg-rose-950/20 border-rose-900/50 text-rose-300 shadow-sm shadow-rose-950/30"
                            : "bg-amber-950/20 border-amber-900/50 text-amber-300 shadow-sm shadow-amber-950/30"
                        }`}
                      >
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-bold uppercase text-xs tracking-wider">
                            {ann.type}
                          </span>
                          <span className="text-xs text-slate-400 truncate max-w-[140px]">
                            {ann.jobId}
                            {ann.stepName ? ` / ${ann.stepName}` : ""}
                          </span>
                          <span className="text-xs text-slate-555">
                            {new Date(ann.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="break-all">{ann.message}</p>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* 사이드바 가로 크기 드래그 조절 핸들 바 */}
        <div
          onMouseDown={startResizeSidebar}
          className={`w-1.5 h-full cursor-col-resize hover:bg-cyan-500/80 active:bg-cyan-500 transition-all z-20 flex-shrink-0 ${
            isResizingSidebar ? "bg-cyan-500" : "bg-transparent"
          }`}
          style={{ marginLeft: "-3px" }}
        />

        {/* 중앙 그래프 및 하단 로그 패널 */}
        <main className="flex-1 flex flex-col overflow-hidden relative h-full">
          {/* 중앙 파이프라인 그래프 */}
          <section className="flex-1 bg-slate-950/85 relative">
            <div className="absolute top-4 left-4 z-10 bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg shadow-lg backdrop-blur-md flex items-center gap-2 pointer-events-none">
              <div
                className={`h-2.5 w-2.5 rounded-full ${viewMode === "session" ? "bg-emerald-500 animate-pulse" : "bg-cyan-500"}`}
              />
              <span className="text-xs text-slate-300 font-bold uppercase tracking-wider">
                {viewMode === "session"
                  ? "실시간 세션 뷰"
                  : "정적 YAML 파이프라인 뷰"}
              </span>
              <span className="text-xs text-slate-500 font-mono">
                {viewMode === "session"
                  ? `(ID: ${selectedSessionId?.slice(0, 8)})`
                  : `(${selectedWorkflowFile})`}
              </span>
            </div>

            <ReactFlow
              key={
                viewMode === "session"
                  ? selectedSessionId
                  : selectedWorkflowFile
              }
              nodes={flowNodes}
              edges={flowEdges}
              onNodeClick={onNodeClick}
              fitView
              colorMode="dark"
            >
              <Background color="#334155" gap={16} />
              <Controls />
              <MiniMap style={{ background: "#0f172a" }} />
            </ReactFlow>
          </section>

          {/* 하단 로그 영역 세로 크기 드래그 조절 핸들 바 */}
          {viewMode === "session" && (
            <div
              onMouseDown={startResizeLog}
              className={`h-1.5 w-full cursor-row-resize hover:bg-cyan-500/80 active:bg-cyan-500 transition-all z-20 ${
                isResizingLog ? "bg-cyan-500" : "bg-slate-850"
              }`}
            />
          )}

          {/* 하단 터미널 실시간 로그 */}
          <section
            style={{
              height: viewMode === "session" ? `${logPanelHeight}px` : "0px",
            }}
            className="bg-slate-950 flex flex-col overflow-hidden transition-all duration-150 relative flex-shrink-0"
          >
            {currentJob && currentJob.logs.length > 0 && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(currentJob.logs.join("\n"));
                  setLogCopied(true);
                  setTimeout(() => setLogCopied(false), 1500);
                }}
                title="로그 전체 복사"
                className="absolute top-2 right-3 z-10 p-1.5 rounded bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-cyan-400 transition"
              >
                {logCopied ? (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </button>
            )}
            <div className="flex items-center justify-between border-b border-slate-850 bg-slate-900/40 px-4 py-2">
              <div className="flex gap-2 items-center">
                <span className="text-sm font-semibold text-slate-400 uppercase">
                  로그 스트리밍:
                </span>
                <div className="flex gap-1.5">
                  {currentSession &&
                    Object.keys(currentSession.jobs).map((jobId) => (
                      <button
                        key={jobId}
                        onClick={() => {
                          setSelectedJobId(jobId);
                          setAnnotationStepFilter(null);
                        }}
                        className={`text-sm px-2.5 py-1 rounded font-medium border transition ${
                          selectedJobId === jobId
                            ? "bg-cyan-950 border-cyan-800/80 text-cyan-400 font-bold shadow-md shadow-cyan-950/40"
                            : "bg-slate-900/50 border-slate-800 text-slate-400 hover:text-slate-355"
                        }`}
                      >
                        {jobId}
                      </button>
                    ))}
                </div>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {currentJob
                  ? `${currentJob.logs.length} Lines`
                  : "No Job selected"}
              </span>
            </div>
            <div className="flex-1 p-4 font-mono text-sm overflow-y-auto bg-black text-slate-300 space-y-1 select-text">
              {currentJob && currentJob.logs.length > 0 ? (
                currentJob.logs.map((logLine, idx) => (
                  <div
                    key={idx}
                    className="whitespace-pre-wrap break-all leading-relaxed"
                  >
                    {logLine}
                  </div>
                ))
              ) : (
                <div className="text-slate-650 text-center py-12 text-sm">
                  출력할 로그 데이터가 없습니다.
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </section>
        </main>
      </div>

      {/* 5단계 Docker 진단 실패 대처 가이드 모달 */}
      {isDiagModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-fade-in">
          <div className="relative bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl flex flex-col space-y-4">
            {/* 모달 헤더 */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl">⚠️</span>
                <h3 className="text-lg font-bold text-slate-100 pr-4">
                  {diagModalTitle}
                </h3>
              </div>
              <button
                onClick={() => setIsDiagModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 transition font-bold text-xl px-2"
              >
                ✕
              </button>
            </div>

            {/* 에러 상세 메시지 영역 */}
            <div className="bg-rose-950/20 border border-rose-900/40 p-3 rounded-lg text-rose-300 text-xs font-mono break-all max-h-32 overflow-y-auto">
              <strong>에러 원인:</strong> {diagModalError}
            </div>

            {/* 해결 가이드 본문 */}
            <div className="flex-1 overflow-y-auto max-h-[30rem] pr-1">
              {diagModalGuide}
            </div>

            {/* 모달 하단 컨트롤 */}
            <div className="flex justify-end pt-3 border-t border-slate-800 gap-3">
              {!isDockerActive && diagModalTitle.includes("데몬") && (
                <button
                  onClick={() => {
                    handleStartDocker();
                    setIsDiagModalOpen(false);
                  }}
                  className="bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold px-4 py-2 rounded-lg text-sm transition"
                >
                  백그라운드에서 데몬 켜기
                </button>
              )}
              <button
                onClick={() => setIsDiagModalOpen(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-4 py-2 rounded-lg text-sm transition"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
