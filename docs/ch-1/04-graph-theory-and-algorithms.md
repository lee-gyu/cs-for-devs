# 1.4 그래프 모델링과 알고리즘 — 실무 문제를 표준 문제로 환원하기

그래프 알고리즘의 실무 가치는 알고리즘 자체보다 **눈앞의 문제가 그래프 문제임을 알아보는 눈**에서 나온다. 패키지 의존성, 배포 순서, 데드락, GC의 객체 추적은 모두 같은 수학적 구조 위의 문제다. 이 문서는 모델링(무엇을 정점과 간선으로 삼는가)을 먼저 세우고, 표현 선택을 [1.2](./02-data-structures-in-memory.md)의 메모리 배치 논리로 연결한 뒤, 탐색·위상 정렬·최단 경로를 "실무 문제 → 그래프 모델 → 표준 알고리즘"의 환원 사례와 함께 다룬다.

## 학습 목표

- 실무 문제에서 정점·간선·방향·가중치를 식별해 그래프로 모델링하고, 적절한 표준 문제(도달성, 위상 정렬, 최단 경로)로 환원한다.
- 인접 리스트와 인접 행렬의 메모리 배치를 근거로 그래프 밀도에 맞는 표현을 선택한다.
- BFS와 DFS의 용도 차이를 설명하고, 재귀 DFS의 스택 깊이 한계를 실측 근거로 판단한다.
- 위상 정렬로 의존성 문제(빌드 순서, 순환 의존)를 풀고, 다익스트라의 정당성 조건과 무너지는 조건(음수 가중치)을 설명한다.

## 배경: 왜 이것이 존재하는가

그래프는 "개체들과 그들 사이의 관계"라는 최소한의 구조만 요구하는 모델이다. 요구가 적다는 것은 적용 범위가 넓다는 뜻이다 — 모듈과 import 관계, 서비스와 호출 관계, 트랜잭션과 잠금 대기 관계, 객체와 참조 관계. 이 각각을 위한 전용 이론을 만드는 대신, 하나의 수학적 구조로 환원하면 수십 년간 축적된 표준 알고리즘과 정리를 그대로 가져다 쓸 수 있다. 환원(reduction)이라는 이 발상은 컴퓨터 과학 전체의 중심 기법이고(복잡도 이론에서의 형식적 취급은 챕터 2), 그래프는 그 환원의 가장 흔한 도착지다.

실무에서 그래프 문제가 어려운 지점은 대체로 알고리즘이 아니다. BFS는 20줄이다. 어려운 것은 (1) 문제를 그래프로 **보는 것** — "마이그레이션이 자꾸 꼬인다"를 "DAG의 위상 정렬"로 번역하기 전까지 문제는 그냥 혼돈이다 — 그리고 (2) 모델링 선택 — 무엇을 정점으로 삼는가에 따라 같은 상황이 쉬운 문제가 되기도, NP-난해 문제가 되기도 한다.

## 핵심 개념

### 모델링 — 무엇이 정점이고 무엇이 간선인가

그래프 G = (V, E)를 확정하려면 네 가지를 결정해야 한다.

1. **정점(vertex)**: 상태인가, 개체인가? 예컨대 배포 문제에서 정점은 "서비스"일 수도, "서비스의 버전 상태"일 수도 있다. 이 선택이 문제의 크기와 난이도를 결정한다.
2. **간선(edge)**: 어떤 관계를 선으로 삼는가? "A가 B를 import한다", "A가 끝나야 B를 시작할 수 있다", "A에서 B로 상태 전이가 가능하다".
3. **방향**: 관계가 비대칭이면 유향(directed). 의존·호출·전이는 거의 항상 유향이다.
4. **가중치**: 간선에 비용(지연 시간, 요금, 거리)이 실리는가?

유향 그래프에 **순환이 없으면 DAG**(directed acyclic graph)다. DAG는 실무에서 각별히 중요한데, "의존 관계에 모순이 없다"는 뜻이며 위상 정렬이 가능해지는 조건이기 때문이다.

익숙한 시스템들을 이 언어로 다시 읽어 보면 — 패키지 매니저의 lockfile은 (패키지, 의존) DAG, CI 파이프라인은 (작업, 선행 조건) DAG, 데이터베이스의 잠금 대기는 (트랜잭션, "~를 기다린다") 유향 그래프, GC의 힙은 (객체, 참조) 유향 그래프다. 모델이 같으므로 질문도 같은 표준 문제로 떨어진다: "어떤 순서로 처리하는가" = 위상 정렬, "서로 기다리며 멈췄는가" = 순환 탐지, "살아 있는 객체는 무엇인가" = 도달성.

### 표현 — 인접 리스트와 인접 행렬

정점 수 |V|, 간선 수 |E|라 하자. 두 표준 표현의 선택은 [1.2](./02-data-structures-in-memory.md)의 메모리 배치 논리 그대로다.

| | 인접 리스트 | 인접 행렬 |
|---|------------|-----------|
| 배치 | 정점마다 이웃 목록 | \|V\|×\|V\| 불리언/가중치 행렬 |
| 공간 | O(\|V\| + \|E\|) | O(\|V\|²) |
| "u→v 있는가" | 이웃 목록 탐색 | O(1) 인덱스 접근 |
| 이웃 순회 | 실제 이웃 수만큼 | 항상 \|V\|칸 스캔 |

실무 그래프는 대부분 **희소**(sparse)하다 — 패키지 하나가 의존하는 패키지는 전체의 극히 일부다. |V| = 10만인 의존성 그래프를 행렬로 담으면 10¹⁰칸(수 GiB)이 거의 전부 0으로 낭비된다. 그래서 기본값은 인접 리스트이고, 행렬은 밀집(dense) 그래프이거나 |V|가 작고 간선 존재 질의가 지배적일 때의 선택지다. 이 문서의 코드는 인접 리스트를 `Map<string, string[]>`으로 표현한다. 성능이 극단으로 필요한 정적 그래프는 이웃 목록들을 하나의 연속 배열에 이어 붙이고 시작 오프셋 배열로 찾는 CSR(compressed sparse row) 형식으로 내려간다 — 1.2의 "포인터 대신 연속 배치" 논리의 그래프판이며, 여기서는 이름만 알아 둔다.

### 탐색 — BFS와 DFS는 방문 순서가 아니라 용도가 다르다

두 탐색 모두 O(|V| + |E|)로 모든 도달 가능한 정점을 방문한다. 차이는 **방문 순서가 보장하는 성질**이다.

**BFS**(breadth-first search)는 큐로 관리되어 시작점에서 가까운 순서로 방문한다. 따라서 각 정점에 처음 도달한 경로가 곧 **최소 간선 수 경로**다. "리전 간 복제가 몇 홉 만에 전파되는가" 같은 질문이 BFS다.

```js
// bfs.mjs — node bfs.mjs 로 실행
function addEdge(graph, from, to) {
  if (!graph.has(from)) graph.set(from, []);
  if (!graph.has(to)) graph.set(to, []);
  graph.get(from).push(to);
}

function bfsDistances(graph, start) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  // shift()는 O(n)이므로 (1.2 참조) 읽기 인덱스를 전진시키는 방식으로 큐를 구현한다
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const next of graph.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cur) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

const topology = new Map();
addEdge(topology, 'seoul', 'tokyo');
addEdge(topology, 'seoul', 'singapore');
addEdge(topology, 'tokyo', 'oregon');
addEdge(topology, 'singapore', 'oregon');
addEdge(topology, 'oregon', 'virginia');
console.log([...bfsDistances(topology, 'seoul')]);
// [['seoul',0], ['tokyo',1], ['singapore',1], ['oregon',2], ['virginia',3]]
```

**DFS**(depth-first search)는 스택(재귀 또는 명시적)으로 한 방향을 끝까지 파고든다. 방문의 시작·종료 시각 구조가 순환 탐지, 위상 정렬, 연결 요소, 도달성 판정의 재료가 된다. [1.3](./03-algorithm-design-paradigms.md)의 백트래킹이 바로 "제약 검사가 붙은 DFS"다.

**재귀 DFS의 경계 조건은 스택 깊이다.** Node.js v24.14.0 기본 설정에서 단순 재귀의 한계를 실측하면 약 1만 프레임에서 `RangeError: Maximum call stack size exceeded`가 난다(프레임 크기에 따라 달라진다 — 지역 변수가 많으면 더 얕아진다).

```js
// node -e 'let d=0; function f(){d++;f();} try{f();}catch{console.log(d);}'
// → 10361 (Node.js v24.14.0, 기본 스택 크기 기준)
```

그래프의 최장 경로가 이 깊이를 넘을 수 있으면 — 수만 정점의 의존성 체인, 깊은 디렉터리 트리 — 재귀 DFS는 입력에 따라 터지는 시한폭탄이다. 명시적 스택의 반복 구현으로 바꾸면 깊이 한계가 힙 크기로 올라간다. "테스트에선 됐는데 큰 저장소에서 터졌다"류 장애의 전형적 원인이다.

**도달성의 실무 사례가 GC다.** 추적 GC의 mark 단계는 루트 집합(스택, 전역)에서 참조 간선을 따라 도달 가능한 객체를 표시하는 그래프 탐색 그 자체이고, 도달 불가능 = 회수 대상이다. "순환 참조인데 왜 수거되나"라는 흔한 질문의 답도 여기 있다 — 추적 GC의 기준은 참조 횟수가 아니라 루트로부터의 도달성이므로, 서로만 참조하는 고립된 순환은 도달 불가능해서 수거된다. GC 알고리즘 자체는 챕터 6에서 다룬다.

### 위상 정렬 — "어떤 순서로 처리해야 하는가"

DAG의 위상 정렬(topological sort)은 모든 간선이 앞→뒤를 향하도록 정점을 일렬로 세운 것이다. "의존하는 것이 먼저"라는 모든 문제 — 빌드 순서, 마이그레이션 순서, 작업 스케줄 — 의 표준 해다. Kahn 알고리즘은 진입 차수(in-degree, 들어오는 간선 수)가 0인 정점을 반복해서 떼어낸다.

```js
// toposort.mjs — node toposort.mjs 로 실행 (addEdge는 bfs.mjs와 동일)
function topologicalSort(graph) {
  const inDegree = new Map([...graph.keys()].map((v) => [v, 0]));
  for (const targets of graph.values()) {
    for (const t of targets) inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([v]) => v);
  const order = [];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    order.push(cur);
    for (const next of graph.get(cur) ?? []) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== inDegree.size) {
    const remaining = [...inDegree.entries()].filter(([, d]) => d > 0).map(([v]) => v);
    throw new Error(`순환 의존 감지: ${remaining.join(', ')}`);
  }
  return order;
}

// 간선 방향은 "먼저 빌드되어야 하는 쪽 → 그것을 기다리는 쪽"으로 둔다
const deps = new Map();
addEdge(deps, 'lib-core', 'lib-ui');
addEdge(deps, 'lib-core', 'lib-api');
addEdge(deps, 'lib-ui', 'app');
addEdge(deps, 'lib-api', 'app');
console.log(topologicalSort(deps)); // [ 'lib-core', 'lib-ui', 'lib-api', 'app' ]

const cyclic = new Map();
addEdge(cyclic, 'a', 'b');
addEdge(cyclic, 'b', 'c');
addEdge(cyclic, 'c', 'a');
topologicalSort(cyclic); // Error: 순환 의존 감지: a, b, c
```

이 코드에 실무 사실 세 개가 들어 있다.

- **순환 탐지가 공짜로 딸려 온다.** 진입 차수 0인 정점이 더 없는데 미처리 정점이 남았다면 그들은 순환에 갇힌 것이다. 패키지 매니저의 "circular dependency" 에러, 모듈 로더가 순환 import에서 미완성 모듈을 돌려주는 현상의 정체가 이것이다.
- **순서는 유일하지 않다.** `lib-ui`와 `lib-api`는 서로 의존이 없으므로 어느 쪽이 먼저여도 된다 — 그리고 이 "동시에 진입 차수 0인 정점들"이 곧 **병렬 실행 가능한 단위**다. 빌드 도구가 병렬화 폭을 찾는 원리다.
- **간선 방향은 모델링 결정이다.** "A가 B에 의존한다"를 A→B로 그리면 위상 정렬 결과를 뒤집어야 한다. 코드에 넣기 전에 간선의 의미를 문장으로 적어 두는 것이 실수를 막는다.

### 최단 경로 — 다익스트라와 그 성립 조건

가중치가 실리면 "최소 홉"(BFS)이 아니라 "최소 비용 합"이 문제가 된다. 다익스트라(Dijkstra) 알고리즘은 [1.3](./03-algorithm-design-paradigms.md)의 그리디다: 아직 확정 안 된 정점 중 **잠정 거리가 가장 작은 것은 더 줄어들 수 없으므로 확정해도 된다** — 다른 경로로 우회해 봤자 이미 그보다 먼 정점을 거쳐야 하기 때문이다. 이 논증이 성립하려면 "우회하면 더 멀어진다", 즉 **음수 가중치가 없다**는 전제가 필요하다.

"잠정 거리 최소 정점"을 반복해서 꺼내는 자료구조가 [1.2](./02-data-structures-in-memory.md)의 이진 힙이고, 전체 비용은 O((|V| + |E|) log |V|)가 된다. 힙에 남은 옛 항목은 꺼낼 때 무효화 검사로 건너뛴다(lazy deletion — 힙 속 임의 원소 갱신보다 단순하다).

```js
// dijkstra.mjs — node dijkstra.mjs 로 실행 (MinHeap 구현은 아래 접힘 참조)
function dijkstra(graph, start) {
  const dist = new Map([[start, 0]]);
  const heap = new MinHeap();
  heap.push({ node: start, priority: 0 });
  while (heap.size > 0) {
    const { node, priority } = heap.pop();
    if (priority > (dist.get(node) ?? Infinity)) continue; // 무효화된 항목 건너뛰기
    for (const { to, weight } of graph.get(node) ?? []) {
      const candidate = priority + weight;
      if (candidate < (dist.get(to) ?? Infinity)) {
        dist.set(to, candidate);
        heap.push({ node: to, priority: candidate });
      }
    }
  }
  return dist;
}

// 서비스 호출 그래프: 가중치는 구간 지연 시간(ms)
const latency = new Map([
  ['gateway', [{ to: 'auth', weight: 5 }, { to: 'cache', weight: 1 }]],
  ['auth', [{ to: 'db', weight: 10 }]],
  ['cache', [{ to: 'auth', weight: 1 }, { to: 'db', weight: 30 }]],
  ['db', []],
]);
console.log([...dijkstra(latency, 'gateway')]);
// [['gateway',0], ['auth',2], ['cache',1], ['db',12]]
// auth는 직행(5)이 아니라 cache 경유(1+1=2), db는 cache→auth→db(1+1+10=12)가 최단
```

::: details MinHeap 전체 구현 (1.2의 배열 기반 이진 힙)
```js
class MinHeap {
  #items = [];
  get size() { return this.#items.length; }
  push(item) {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= items[i].priority) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1, right = 2 * i + 2;
        let smallest = i;
        if (left < items.length && items[left].priority < items[smallest].priority) smallest = left;
        if (right < items.length && items[right].priority < items[smallest].priority) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
```
:::

**무너지는 조건**: 음수 가중치 간선이 있으면 "확정" 논증이 깨진다 — 나중에 발견된 음수 간선 경유 경로가 이미 확정한 거리보다 짧을 수 있다. 환불·보상이 섞인 비용 모델, 이득이 있는 상태 전이를 그래프로 만들면 음수 간선이 자연스럽게 생긴다. 이때는 간선을 |V|-1회 완화(relax)하는 벨만-포드(Bellman-Ford)가 답이고(DP 구조, O(|V|·|E|)), 음수 **순환**까지 있으면 "최단"이라는 개념 자체가 정의되지 않는다(돌수록 싸진다). 벨만-포드는 음수 순환의 존재를 탐지해 준다.

목적지가 하나로 정해져 있고 좋은 거리 추정치(휴리스틱)가 있으면 다익스트라에 방향성을 준 A*가 후보가 되는데, 필요할 때 찾아볼 수 있도록 이름만 남겨 둔다.

## 실무 관점

### 환원 사례 모음 — 문제 → 모델 → 표준 문제

| 실무 문제 | 정점 | 간선 | 표준 문제 |
|-----------|------|------|-----------|
| 모노레포 빌드 순서·병렬화 | 패키지 | 의존(유향) | 위상 정렬 |
| 순환 import 탐지 | 모듈 | import(유향) | 순환 탐지 (DFS/Kahn) |
| DB 데드락 감지 | 트랜잭션 | 잠금 대기(유향) | 순환 탐지 |
| GC 생존 객체 판정 | 객체 | 참조(유향) | 루트 도달성 (탐색) |
| 장애 영향 범위("이 서비스가 죽으면?") | 서비스 | 호출(유향) | 도달성 (역방향 탐색) |
| 복제 전파 홉 수 | 노드 | 링크 | BFS |
| 최저 지연 경로, 환승 최소화 | 지점/상태 | 비용 있는 전이 | 다익스트라 |
| 권한 상속 해석 | 주체/역할 | 상속 | DAG 도달성 |

이 표에서 읽을 것은 목록이 아니라 패턴이다: **관계가 유향이고 "순서" 또는 "도달"을 묻고 있다면 그래프 문제일 확률이 높다.** 데드락 감지의 wait-for 그래프는 챕터 8(운영체제)과 챕터 11(트랜잭션)에서, GC는 챕터 6에서 각자의 맥락으로 다시 등장한다 — 알고리즘은 이 문서의 것이 그대로 쓰인다.

### 모델링이 난이도를 결정한다

같은 상황도 질문에 따라 다른 문제가 된다. "이 작업들을 의존 순서대로 나열하라"는 위상 정렬(선형 시간)이지만, "모든 도시를 한 번씩 방문하는 최소 비용 경로"(외판원 문제, TSP)나 "충돌하는 작업들에 최소 개수의 슬롯을 배정"(그래프 색칠)은 NP-난해다. 그래프로 모델링됐다고 풀리는 것이 아니라, **어떤 표준 문제로 떨어졌는지**가 운명을 결정한다. 다항 시간 문제와 NP-난해 문제를 가르는 이론과, NP-난해로 판명됐을 때의 실무 전략(근사·휴리스틱·솔버)은 챕터 2에서 다룬다. 이 단계에서 필요한 감각은 하나다 — 환원 결과가 "순서 세우기·도달성·최단 경로"면 안전지대, "모든 조합 중 최적 하나"면 경보다.

### 규모와 표현의 현실

- 수십만 정점까지의 인접 리스트 탐색은 어지간하면 문제가 없다 — O(|V| + |E|)는 강력한 보장이다. 성능이 무너진다면 알고리즘이 아니라 구현(정점마다 객체 할당, 문자열 키 해싱 반복)이 원인인 경우가 많다. [1.2](./02-data-structures-in-memory.md)의 논리대로 정점을 정수 인덱스로, 이웃 목록을 연속 배열로 바꾸는 것이 첫 처방이다.
- 그래프가 메모리를 넘거나(수억 간선) 질의가 온라인으로 계속 들어오면 전용 저장소·배치 처리의 영역이다(챕터 17). 도구를 바꾸더라도 질의를 표준 문제로 환원하는 이 문서의 작업은 그대로 선행된다.

## 정리

- 그래프 실력의 절반은 모델링이다: 정점·간선·방향·가중치를 확정하고 간선의 의미를 문장으로 적으면, 실무 문제가 표준 문제(도달성, 위상 정렬, 최단 경로, 순환 탐지)로 환원된다.
- 실무 그래프는 대부분 희소하므로 인접 리스트가 기본값이고, 표현 선택은 1.2의 메모리 배치 논리를 따른다.
- BFS는 최소 홉을, DFS는 순환·연결·도달성 분석의 구조를 준다. 재귀 DFS는 약 1만 프레임(Node 기본 설정 실측)에서 터지므로 깊이가 입력에 달린 그래프에는 반복 구현을 쓴다.
- 위상 정렬은 의존 순서 문제의 표준 해이고, 순환 탐지와 병렬화 단위 식별이 부산물로 나온다.
- 다익스트라는 "음수 가중치 없음" 위에서만 성립하는 그리디다. 음수 간선은 벨만-포드, 음수 순환은 문제 정의 자체의 재검토가 필요하다.
- 환원 결과가 어떤 표준 문제인지가 난이도를 결정한다. NP-난해 문제로 떨어지는 신호를 알아채는 것까지가 이 챕터의 몫이고, 그다음은 챕터 2다.

## 확인 문제

**1.** 마이크로서비스 12개를 새 인증 방식으로 전환하려 한다. 제약: 각 서비스는 자신이 호출하는 서비스가 먼저 전환된 뒤에만 전환할 수 있고, 무관한 서비스들은 동시에 전환해 기간을 줄이고 싶다. 이 문제를 그래프로 모델링하고(정점·간선·방향을 명시), 전환 계획과 "며칠 걸리는가"의 답을 주는 알고리즘을 제시하라. 계획 수립이 불가능한 경우는 어떻게 감지되는가?

::: details 정답과 해설
정점 = 서비스, 간선 = "A가 B를 호출한다"에서 B→A (피호출자가 먼저 전환되어야 하므로 '먼저'인 쪽에서 '나중'인 쪽으로). 이 그래프가 DAG면 Kahn 위상 정렬이 전환 순서를 주고, 각 라운드에서 동시에 진입 차수 0이 되는 서비스들이 병렬 전환 가능한 묶음이다. 소요 기간은 라운드 수 = 그래프의 최장 경로 길이(critical path)로, 라운드별로 묶어 세면 나온다. 상호 호출(순환)이 있으면 위상 정렬이 완료되지 못하고 미처리 정점이 남아 감지된다 — 이 경우 순환에 낀 서비스들은 위상 정렬로 풀 수 없으므로, 듀얼 스택(구/신 방식 동시 지원)으로 순환을 임시로 끊는 등 모델 밖의 결정이 필요하다. "알고리즘이 불가능을 알려 주는 것"까지가 모델링의 가치다.
:::

**2.** 포인트 적립(음수 비용)과 수수료(양수 비용)가 섞인 송금 네트워크에서 최저 비용 송금 경로를 다익스트라로 구현했더니, 특정 경로에서 실제보다 비싼 답이 나온다. 왜 다익스트라가 틀린 답을 내는지 확정 논증이 깨지는 지점으로 설명하고, 대안과 함께 "이 문제에서 답이 아예 정의되지 않는 경우"도 지적하라.

::: details 정답과 해설
다익스트라는 "잠정 거리 최소인 정점은 확정해도 된다"는 그리디인데, 그 근거는 다른 경로로 우회하면 비용이 늘어날 수밖에 없다는 것이다. 음수 간선(적립)이 있으면 지금은 멀어 보이는 경로가 뒤에서 비용을 깎아 최종적으로 더 쌀 수 있어, 이미 확정한 거리가 틀린 값으로 굳는다. 대안은 벨만-포드: 모든 간선을 |V|-1회 완화하는 DP로 음수 간선을 허용한다(비용 O(|V|·|E|)). 단, 음수 순환 — 돌 때마다 총비용이 줄어드는 사이클(예: 적립이 수수료를 초과하는 순환 송금) — 이 존재하면 "최저 비용"이 -∞로 발산해 문제 자체가 정의되지 않는다. 벨만-포드는 이를 탐지할 수 있고, 탐지되면 알고리즘 교체가 아니라 비즈니스 규칙(적립 상한 등) 차원의 재설계가 필요하다.
:::

**3.** 모노레포 도구가 순환 import 탐지를 재귀 DFS로 구현했고 사내 저장소에서는 수년간 문제없었는데, 코드 생성기가 만든 8만 파일짜리 저장소에서 이유 없이 죽는다는 제보가 왔다. 에러조차 없이 프로세스가 종료되는 경우도 있다. 원인 가설을 세우고, 검증 방법과 수정 방향을 제시하라.

::: details 정답과 해설
가설: 생성된 코드가 매우 긴 import 체인(깊은 경로)을 갖고 있어 재귀 DFS가 스택 깊이 한계(본문 실측: Node 기본 설정에서 약 1만 프레임, 프레임이 크면 더 얕음)를 넘는다. `RangeError`로 죽으면 그나마 단서가 남지만, 스택 오버플로가 네이티브 계층에서 나면 진단 메시지 없이 프로세스가 종료될 수 있다. 검증: (1) 해당 저장소에서 그래프의 최장 경로 깊이를 별도 측정해 한계와 비교, (2) `node --stack-size`를 늘려 증상이 사라지는지 확인(원인 확정용이지 수정책이 아니다 — 이 값을 늘리는 것은 한계를 옮길 뿐이고 네이티브 스택과의 상호작용이 있어 근본 대책이 되지 못한다). 수정: DFS를 명시적 스택의 반복 구현으로 바꿔 깊이 한계를 힙 메모리로 옮긴다. 회귀 방지로 "깊이 10만의 선형 체인 그래프" 테스트를 추가한다. 입력 크기에 비례해 깊어지는 재귀는 전부 같은 위험을 갖는다(1.3의 top-down DP 포함).
:::

## 참고 자료

- Cormen, Leiserson, Rivest, Stein, *Introduction to Algorithms* 4th ed. (2022), VI부 Graph Algorithms — BFS/DFS/위상 정렬(20장), 최단 경로(22장)의 표준 서술과 정당성 증명.
- E. W. Dijkstra, [A Note on Two Problems in Connexion with Graphs](https://ir.cwi.nl/pub/9256) (1959) — 원 논문. 3쪽 분량으로, 알고리즘이 "확정 집합을 넓혀 가는" 원형 그대로 서술되어 있다.
- A. B. Kahn, "Topological Sorting of Large Networks" (*Communications of the ACM*, 1962) — 본문 위상 정렬 알고리즘의 원 논문. PERT 일정 네트워크가 원래의 응용이었다는 점이 "실무 환원" 관점에서 흥미롭다.
- Sedgewick, Wayne, *Algorithms* 4th ed. (2011), 4장 Graphs — 인접 리스트 구현과 응용 사례 중심의 서술. [부속 사이트](https://algs4.cs.princeton.edu/40graphs/)에 코드와 시각화가 있다.
- V8 blog, [Trash talk: the Orinoco garbage collector](https://v8.dev/blog/trash-talk) — mark 단계가 참조 그래프 탐색으로 서술되는 것을 확인할 수 있다. 챕터 6의 예습 자료.
