# 챕터 8 실습 — 컨텍스트 스위치 비용과 I/O 모델별 처리량 측정

[ROADMAP](../../ROADMAP.md) 챕터 8의 산출물인 **"컨텍스트 스위치 비용과 I/O 모델(블로킹, epoll 계열)별 처리량을 직접 측정하고 시스템 지표로 차이의 원인을 설명한다"**를 수행하는 실습이다. [plan/ch-8.md](../../plan/ch-8.md) §5 기획을 기준으로 하며, [8.0 인트로](../../docs/ch-8/00-introduction.md)의 문제의식과 챕터 8 본문 3편([8.1](../../docs/ch-8/01-processes-and-scheduling.md), [8.2](../../docs/ch-8/02-virtual-memory.md), [8.3](../../docs/ch-8/03-file-systems-and-io.md))의 동작 모델을 전제로 한다.

## 학습 목표

- 모드 전환(시스템 콜)과 컨텍스트 스위치의 비용을 **분리해서** 실측하고, 측정 방법의 한계를 서술한다.
- 컨텍스트 스위치의 간접 비용(캐시 재워밍업)이 working set 크기에 따라 커지는 것을 관찰한다.
- 블로킹 + thread-per-connection, epoll 단일 스레드, Node.js(libuv) 세 서버의 처리량·지연·메모리·스위치 곡선을 동시 연결 수의 함수로 측정한다.
- 측정 결과의 차이를 시스템 지표(pidstat, vmstat, RSS, user/sys CPU)로 설명하고, 어느 규모부터 이벤트 루프가 이기는지(교차점)를 근거와 함께 제시한다.

## 실행 환경

**Linux가 필수다** — epoll, `/proc`, `taskset`, `pidstat`을 사용한다. 개발 머신이 macOS라면 Linux 컨테이너에서 실행한다. 이 실습은 PMU 같은 특권 하드웨어 접근이 없어 컨테이너로 충분하다(챕터 7 실습의 하드웨어 카운터 검증과 달리 VM/실기가 필요하지 않다).

기준 환경은 **Docker(또는 호환 런타임)의 Ubuntu 24.04 컨테이너**로 한다. Lima/UTM 등의 Linux VM을 써도 되며, 절차는 동일하다.

```sh
# 저장소 루트에서 실행. strace를 위해 SYS_PTRACE 권한을 추가한다.
docker run -it --rm \
  --cap-add=SYS_PTRACE \
  -v "$PWD/exercises/ch-8":/work -w /work \
  ubuntu:24.04 bash

# 컨테이너 안에서
apt-get update && apt-get install -y build-essential strace sysstat time nodejs
```

### 측정 규율

- **환경 명시**: 리포트에 커널 버전(`uname -r`), CPU 모델, 코어 수, 컨테이너/VM 여부, 코어 고정 설정을 기록한다. macOS 위 컨테이너는 실제로는 VM 안이므로 절대값이 실기와 다르다 — 결론은 절대값이 아니라 **배율과 곡선의 모양**으로 서술한다.
- **노이즈 통제**: 측정 프로세스를 `taskset`으로 코어에 고정하고, 측정 중 같은 머신에서 다른 부하(빌드, 브라우저)를 돌리지 않는다. 반복 측정 후 중앙값을 취한다 — 방법론은 [ch-1 벤치마크 방법론](../../docs/ch-1/01-complexity-analysis.md)을 그대로 적용한다.
- **언어**: 측정 대상 프로그램은 **C**로 작성한다(C11, `gcc -O2`, 단일 Makefile 수준의 빌드). 컨텍스트 스위치·I/O 모델 비교에 GC·JIT·런타임 스레드가 끼면 원인 분리가 불가능하기 때문이다. Node.js는 "libuv = epoll 사용자"를 확인하는 대조군으로만 쓴다.
- **부하 클라이언트도 직접 작성한다**: 동시 연결 수와 요청 크기를 정확히 제어하고 지연 분포(p50/p99)를 직접 기록하기 위해서다. 기존 도구(wrk 등)는 교차 검증용으로만 쓴다.

권장 파일 배치(빌드·측정을 스크립트 하나로 재현할 수 있어야 한다):

```text
exercises/ch-8/
├── README.md            # 이 문서
├── Makefile
├── part-a/              # syscall.c, pingpong.c, cachecost.c
├── part-b/              # server-thread.c, server-epoll.c, server-node.js, client.c
├── run-a.sh  run-b.sh   # 측정 재현 스크립트
└── report.md            # 결과 리포트
```

## Part A — 모드 전환과 컨텍스트 스위치 비용 분리

목표: "시스템 콜은 수십~수백 ns, 컨텍스트 스위치는 ~μs + 간접 비용"이라는 [8.1](../../docs/ch-8/01-processes-and-scheduling.md)의 자릿수 주장을 자기 환경의 수치로 대체한다.

### A-1. 모드 전환 단독 측정

1. 가장 싼 시스템 콜(예: `getppid()` 또는 0바이트 `read`)을 수백만 회 반복하고 총 시간을 횟수로 나눠 왕복 단가를 구한다. 시간 측정은 `clock_gettime(CLOCK_MONOTONIC)`으로 루프 바깥에서 한다.
2. 대조군으로 vDSO 처리 함수(`clock_gettime` 자체)와 순수 함수 호출을 같은 방식으로 측정해 세 단가(함수 호출 < vDSO < 시스템 콜)를 비교한다.
3. `strace -c`로 두 대상의 시스템 콜 여부를 확인한다(vDSO 호출은 strace에 잡히지 않아야 한다). strace를 붙인 채로는 시간 측정을 하지 않는다.

### A-2. 컨텍스트 스위치 단가 측정 (pipe ping-pong)

1. 파이프 두 개로 연결된 프로세스(또는 스레드) 쌍이 1바이트를 주고받는 ping-pong을 구현한다. 한쪽이 read로 블로킹하면 커널은 반대쪽으로 스위치하므로, **왕복 1회 = 컨텍스트 스위치 2회 + read/write 시스템 콜 4회**다.
2. 두 태스크를 `taskset -c 0`으로 **같은 코어에 고정**한다(고정하지 않으면 두 코어에서 스핀 대기와 IPI가 섞여 스위치 단가가 측정되지 않는다).
3. 왕복 단가에서 A-1의 시스템 콜 단가 × 4를 빼서 스위치 2회분을 분리한다.
4. 같은 측정을 프로세스 쌍과 스레드 쌍(pthread)으로 반복해, 주소 공간 전환 유무의 차이가 보이는지 기록한다.

### A-3. 간접 비용 — working set과 재워밍업

1. ping-pong의 각 턴 사이에 크기 W의 배열을 순회(읽기+쓰기)하는 작업을 끼운다. W를 L1보다 작은 크기(예: 16KiB)부터 LLC를 넘는 크기(예: 32MiB)까지 단계적으로 늘린다.
2. 각 W에서 (a) 단독 실행(스위치 없음)의 턴당 시간과 (b) ping-pong 실행의 턴당 시간을 비교한다. (b) − (a) − 직접 비용이 재워밍업 비용의 근사다.
3. W가 커질수록 이 차이가 커지는지(스위치 직접 비용은 상수인데 총 비용은 증가) 곡선으로 기록한다. 이것이 [8.1의 "간접 비용이 직접 비용을 압도한다"](../../docs/ch-8/01-processes-and-scheduling.md)의 실측 근거가 된다.

### A-4. 교차 검증

`/proc/<pid>/status`의 `voluntary_ctxt_switches`를 측정 전후로 읽어, ping-pong 왕복 횟수와 스위치 카운터 증가량이 일치하는지 확인한다. 일치하지 않으면(예: 비자발적 스위치 혼입) 원인을 리포트에 기록한다.

## Part B — I/O 모델별 echo 서버 처리량

목표: [8.3의 아키텍처 논거](../../docs/ch-8/03-file-systems-and-io.md) — "thread-per-connection 비용은 연결 수에 비례하고, 이벤트 루프의 이득은 동시성의 단가"라는 명제를 곡선으로 확인하고 교차점을 찾는다.

### 서버 3종 (모두 TCP echo: 받은 바이트를 그대로 되돌린다)

1. **blocking + thread-per-connection (C)**: accept 후 연결마다 pthread를 생성(또는 미리 만든 스레드에 배정)하고, 각 스레드는 블로킹 read/write 루프를 돈다.
2. **epoll 단일 스레드 (C)**: 논블로킹 fd + epoll. 기본은 level-triggered로 구현하고, 여력이 있으면 edge-triggered 버전에서 소진 계약(EAGAIN까지 읽기)을 구현해 비교한다.
3. **Node.js `net` 서버 (대조군)**: `net.createServer((s) => s.pipe(s))` 수준. 측정 전에 `strace -f -e trace=epoll_ctl,epoll_wait`로 epoll 사용을 확인해 "libuv = epoll 사용자"를 기록한다.

### 부하 클라이언트 (C)

- 동시 연결 수 N을 인자로 받아 N개의 연결을 유지하며, 각 연결에서 고정 크기 요청(예: 128B)을 보내고 echo를 받으면 다음 요청을 보낸다.
- 요청별 왕복 시간을 기록해 종료 시 처리량(req/s), p50, p99를 출력한다. 클라이언트 자체가 병목이 되지 않게 클라이언트도 epoll(또는 다중 스레드)로 구현하고, 서버와 **다른 코어 집합**에 고정한다.

### 측정 매트릭스

동시 연결 수 N ∈ {10, 100, 1,000, 10,000(가능 범위)}에서, 각 서버에 대해 다음을 기록한다. 10k 연결에는 fd 한도 상향(`ulimit -n`)과 클라이언트 포트 고갈 대비가 필요하다 — 조정한 값을 리포트에 명시한다.

| 항목 | 도구 |
|------|------|
| 처리량 (req/s), p50/p99 지연 | 클라이언트 출력 |
| 서버 RSS | `/proc/<pid>/status` VmRSS (측정 구간 피크) |
| 서버 스위치 (cswch/s, nvcswch/s) | `pidstat -w -t -p <pid> 1` |
| CPU user/sys 분리 | `pidstat -u -p <pid> 1` |
| 시스템 전체 | `vmstat 1` (r, cs) |

### 분석 포인트 (리포트에 답할 질문)

- thread-per-connection에서 N 증가가 RSS, cswch/s, sys CPU에 각각 어떤 기울기로 나타나는가? 어느 지표가 먼저 한계에 닿는가?
- 저동시성(N=10)에서 epoll 서버가 이점이 없거나 지는가? 시스템 콜 수 관점(연결당 read 1회 vs epoll_wait+read)으로 설명이 되는가?
- 어느 N부터 이벤트 루프가 처리량 또는 p99에서 이기는가? 그 교차점에서 시스템 지표는 무엇이 달라졌는가?
- Node 서버와 C epoll 서버의 차이는 어디서 오는가(런타임 오버헤드 vs I/O 모델)?

### 선택 확장

io_uring 버전 echo 서버(liburing 사용)를 추가하고, `strace -c`로 세 서버의 요청당 시스템 콜 수를 비교한다. 컨테이너의 seccomp 프로파일이 io_uring을 제한하면 그 사실 자체를 기록한다([8.3의 채택 경계](../../docs/ch-8/03-file-systems-and-io.md) 확인 사례가 된다).

## 리포트 요구사항 (`report.md`)

1. **실행 환경**: 커널 버전, CPU, 코어 수, 컨테이너/VM 여부, 코어 고정과 ulimit 설정.
2. **Part A 결과**: 함수 호출/vDSO/시스템 콜/컨텍스트 스위치의 단가 표, working set 크기별 간접 비용 곡선, 측정 방법의 한계(빼기 방식의 오차 원인, 타이머 해상도, 컨테이너로 인한 왜곡)를 명시한다.
3. **Part B 결과**: N별·서버별 처리량/p50/p99/RSS/스위치/CPU 표와 곡선, 교차점과 그 근거가 되는 지표 변화의 서술.
4. **결론**: "이 워크로드 형태(요청 크기·연결 유휴율)에서, 어느 규모부터 어떤 모델을 선택하는가"를 측정 근거로 진술한다.

## 완료 기준

- [ ] Part A: 모드 전환과 컨텍스트 스위치 단가가 분리된 수치로 제시되고, `/proc` 카운터 교차 검증(A-4)이 포함된다.
- [ ] Part A: working set 크기에 따른 간접 비용 곡선이 제시된다.
- [ ] Part B: 서버 3종이 동작하고, N=10~1k(가능하면 10k)의 측정 매트릭스가 채워져 있다.
- [ ] Part B: Node 서버의 epoll 사용이 strace 출력으로 확인되어 있다.
- [ ] 각 측정이 스크립트 하나(`run-a.sh`, `run-b.sh`)로 재현되고, 리포트에 실행 환경과 측정 한계가 명시되어 있다.
- [ ] 분석 포인트의 질문들에 시스템 지표를 근거로 답했다.
