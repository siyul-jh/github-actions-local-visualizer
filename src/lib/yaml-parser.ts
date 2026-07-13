import yaml from 'yaml';

export interface WorkflowNode {
  id: string;
  type: string;
  data: { label: string; status: 'pending' | 'running' | 'success' | 'failure' };
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
}

export function parseWorkflowYaml(yamlContent: string, jobStatuses: Record<string, 'pending' | 'running' | 'success' | 'failure'> = {}): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  try {
    const parsed = yaml.parse(yamlContent);
    if (!parsed || !parsed.jobs) {
      return { nodes: [], edges: [] };
    }

    const jobs = parsed.jobs;
    const jobIds = Object.keys(jobs);
    
    // 1. 의존성 깊이 계산 (DAG 레벨링)
    const levels: Record<string, number> = {};
    const adjList: Record<string, string[]> = {}; // key가 parent, value가 children
    const needsMap: Record<string, string[]> = {};

    jobIds.forEach(jobId => {
      const job = jobs[jobId];
      let needs: string[] = [];
      if (job.needs) {
        needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      }
      needsMap[jobId] = needs;
      
      needs.forEach(parent => {
        if (!adjList[parent]) adjList[parent] = [];
        adjList[parent].push(jobId);
      });
    });

    // 재귀 함수로 노드의 최대 레벨 계산
    function calculateLevel(jobId: string, visited: Set<string> = new Set()): number {
      if (levels[jobId] !== undefined) return levels[jobId];
      if (visited.has(jobId)) return 0; // 순환 의존성 감지 시 순환 탈출
      visited.add(jobId);

      const needs = needsMap[jobId] || [];
      if (needs.length === 0) {
        levels[jobId] = 0;
        return 0;
      }

      const parentLevels = needs.map(parent => calculateLevel(parent, visited));
      const maxParentLevel = Math.max(...parentLevels);
      levels[jobId] = maxParentLevel + 1;
      return levels[jobId];
    }

    jobIds.forEach(jobId => calculateLevel(jobId));

    // 2. 레벨별 노드 카운트 (y좌표 밸런싱을 위해)
    const levelCounts: Record<number, number> = {};
    jobIds.forEach(jobId => {
      const lvl = levels[jobId] || 0;
      levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
    });

    const currentLevelYIndex: Record<number, number> = {};

    // 3. 노드 생성
    const nodes: WorkflowNode[] = jobIds.map(jobId => {
      const lvl = levels[jobId] || 0;
      const count = levelCounts[lvl] || 1;
      const yIndex = currentLevelYIndex[lvl] || 0;
      currentLevelYIndex[lvl] = yIndex + 1;

      // 정렬 배치 계산
      const x = 50 + lvl * 250;
      // y축 중앙 정렬
      const startY = 150 - ((count - 1) * 80) / 2;
      const y = startY + yIndex * 80;

      const status = jobStatuses[jobId] || 'pending';

      return {
        id: jobId,
        type: 'default',
        data: { label: jobId, status },
        position: { x, y }
      };
    });

    // 4. 간선(Edge) 생성
    const edges: WorkflowEdge[] = [];
    jobIds.forEach(jobId => {
      const needs = needsMap[jobId] || [];
      needs.forEach(parent => {
        edges.push({
          id: `e-${parent}-${jobId}`,
          source: parent,
          target: jobId,
          animated: jobStatuses[parent] === 'running' || jobStatuses[jobId] === 'running'
        });
      });
    });

    return { nodes, edges };
  } catch (err) {
    console.error('Failed to parse workflow yaml:', err);
    return { nodes: [], edges: [] };
  }
}
