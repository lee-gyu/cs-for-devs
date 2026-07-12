# 8.2 가상 메모리 — 할당은 약속이고 페이지 폴트가 지급이다

`malloc`이 성공해도 메모리는 아직 없고, RSS·VSZ·페이지 캐시는 각각 다른 것을 센다. 이 문서는 가상 주소가 물리 메모리로 연결되는 경로(페이지 테이블, TLB)와 그 위의 정책들(demand paging, copy-on-write, overcommit)을 세워서, "메모리 사용량"이라는 숫자들을 정확히 읽고 페이지 폴트·OOM·thrashing을 동작 모델로 진단할 수 있게 한다. 기준 OS는 Linux(커널 6.x)다. [8.1](./01-processes-and-scheduling.md)에서 미뤄 둔 두 가지 — fork가 싼 이유, 컨텍스트 스위치가 바꾸는 "주소 공간"의 실체 — 를 여기서 회수한다.

## 학습 목표

- 가상 주소가 다단계 페이지 테이블과 TLB를 거쳐 물리 주소로 변환되는 경로와 각 단계의 비용을 설명한다.
- demand paging, copy-on-write, overcommit 모델로 "할당됐지만 지급되지 않은" 메모리 상태를 설명하고 minor/major 페이지 폴트를 구분한다.
- VSZ, RSS, PSS, 페이지 캐시가 각각 무엇을 세는지 구분해 `ps`·`free`·컨테이너 메모리 지표를 해석한다.
- OOM kill, 스왑 사용, thrashing의 신호를 구분하고 각각의 진단 절차를 세운다.

## 배경: 왜 이것이 존재하는가

프로그램이 물리 주소를 직접 쓰던 시절의 문제를 나열하면 가상 메모리의 존재 이유가 된다. 프로세스 간 격리가 없어서 잘못된 포인터 하나가 다른 프로그램(이나 OS)의 메모리를 덮었다. 프로그램을 메모리의 어디에 올릴지가 컴파일 시점에 박혀서 재배치가 어려웠다. 여러 프로그램이 들락거리면 빈 공간이 조각나 큰 연속 영역을 확보할 수 없었다. 그리고 프로그램은 물리 메모리보다 클 수 없었다.

가상 메모리는 이 문제들을 한 번의 간접화(indirection)로 푼다. **각 프로세스에게 독립된 가상 주소 공간을 주고, 가상 주소 → 물리 주소 변환 테이블을 커널이 관리한다.** 격리는 "남의 물리 메모리로 가는 매핑을 아예 만들어 주지 않는 것"으로, 연속성은 "가상으로 연속인 페이지들을 물리적으로 흩어 놓는 것"으로, 공유는 "두 프로세스의 매핑이 같은 물리 페이지를 가리키게 하는 것"으로 해결된다. 매핑의 단위가 **페이지**(Linux x86-64 기본 4KiB)다.

비용도 명확하다. 모든 메모리 접근에 변환이 하나 끼어든다. 이 비용을 하드웨어(MMU와 TLB)가 흡수하는 구조, 그리고 변환 테이블이라는 간접화가 열어 준 정책 공간 — 나중에 지급하기(demand paging), 쓸 때 복사하기(copy-on-write), 지급 능력보다 많이 약속하기(overcommit) — 이 이 문서의 본론이다. 이 정책들은 전부 Linux의 구현 선택이다. POSIX는 `mmap` 같은 인터페이스와 의미론을 정의할 뿐, 언제 물리 페이지를 지급할지는 규정하지 않는다.

## 핵심 개념

### 주소 변환 — 페이지 테이블과 TLB

프로세스의 포인터에 담긴 값은 전부 가상 주소다. CPU가 메모리에 접근할 때마다 MMU(Memory Management Unit)가 이를 물리 주소로 변환한다. 변환 규칙을 담은 자료구조가 **페이지 테이블**이고, 프로세스마다 하나씩 있다 — [8.1](./01-processes-and-scheduling.md)에서 "프로세스 간 컨텍스트 스위치는 주소 공간 전환이 추가된다"고 한 것의 실체가 페이지 테이블 베이스 레지스터(x86-64의 CR3) 교체다.

가상 주소 공간은 넓고(x86-64에서 48비트, 256TiB) 실제 사용 영역은 듬성듬성하므로, 테이블은 평평한 배열이 아니라 **다단계 트리**다. x86-64는 기본 4단계(최신 CPU는 선택적으로 5단계)로, 가상 주소를 9비트씩 잘라 각 단계의 인덱스로 쓴다. 사용하지 않는 주소 영역의 하위 테이블은 아예 만들지 않으므로 공간이 절약되지만, 대신 **변환 한 번이 메모리 접근 네 번**(단계마다 한 번)이 된다.

모든 메모리 접근마다 네 번을 더 읽을 수는 없으므로, MMU는 최근 변환 결과를 **TLB**(Translation Lookaside Buffer)에 캐시한다. TLB 적중이면 변환 비용은 사실상 0이고, 미스면 하드웨어가 페이지 테이블을 걸어 내려간다(page walk). [7.2 메모리 계층과 캐시 일관성](../ch-7/02-memory-hierarchy.md)에서 다루는 캐시 모델이 주소 변환에도 그대로 적용된 것이다 — 지역성이 좋으면 TLB가 흡수하고, working set이 TLB 커버리지를 넘으면 접근마다 walk 비용이 붙는다. 감각을 위한 자릿수: L1 TLB는 수십 엔트리 규모로, 4KiB 페이지 기준 커버리지가 수백 KiB 수준에 불과하다(정확한 구성은 CPU 모델 의존이며 `cpuid` 같은 도구로 확인할 수 있다). working set이 커서 TLB 미스가 지배하는 워크로드를 위해 페이지 자체를 키우는 **huge page**(x86-64에서 2MiB/1GiB)와 이를 자동 적용하는 THP(Transparent Huge Pages)가 있다 — 이 문서에서는 "TLB 커버리지를 늘리는 도구"라는 위치만 잡아 둔다.

컨텍스트 스위치와의 상호작용도 여기서 결정된다. 주소 공간이 바뀌면 TLB의 기존 항목은 (주소 공간 태그가 없다면) 무효가 되어야 하고, 이것이 [8.1에서 말한 스위치 간접 비용](./01-processes-and-scheduling.md)의 TLB 쪽 절반이다. x86의 PCID 같은 태그 기능이 전체 플러시를 완화한다.

### demand paging — 할당은 약속이다

`malloc(1GiB)`이 리턴한 순간, 커널이 한 일은 물리 메모리 지급이 아니라 **장부 기입**이다. 커널은 프로세스의 주소 공간에 "이 가상 주소 구간은 유효하다"는 영역(VMA, virtual memory area — `/proc/<pid>/maps`에서 볼 수 있다)을 기록할 뿐, 페이지 테이블에 물리 페이지를 연결하지 않는다.

실제 지급은 프로세스가 그 주소에 **처음 접근하는 순간** 일어난다. 매핑 없는 주소 접근은 하드웨어 예외 — **페이지 폴트(page fault)** — 를 일으키고, 커널의 폴트 핸들러가 장부(VMA)를 확인한다. 유효한 약속이면 물리 페이지를 한 장 지급하고 테이블에 연결한 뒤 그 명령을 재실행한다. 장부에 없는 주소면 그 유명한 SIGSEGV다. 즉 segfault란 "약속되지 않은 주소에 대한 폴트"이고, 정상 실행 중에도 폴트는 항상 일어나고 있다.

폴트는 비용이 다른 두 부류로 나뉜다.

- **minor fault**: 디스크 I/O 없이 해결되는 폴트. 새 익명 페이지 지급, 이미 메모리(페이지 캐시)에 있는 파일 페이지의 매핑, CoW 복사가 여기 속한다. 비용은 커널 경로 + 페이지 준비로 μs 자릿수다.
- **major fault**: 디스크에서 읽어 와야 하는 폴트. 파일 페이지가 캐시에 없거나, 스왑으로 나간 페이지를 다시 들여올 때다. 비용은 디스크 I/O 지연 그 자체 — 밀리초까지 갈 수 있고, **지연 스파이크의 흔한 정체**다.

관찰 예제 (Linux 전용, 이하 동일):

```c
// demand.c — 할당 직후와 실제 쓰기 후의 RSS를 비교한다
// 빌드: gcc -O2 demand.c -o demand
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print_rss(const char *label) {
    FILE *f = fopen("/proc/self/status", "r");
    char line[256];
    while (fgets(line, sizeof line, f))
        if (strncmp(line, "VmRSS", 5) == 0) printf("%-12s %s", label, line);
    fclose(f);
}

int main(void) {
    size_t size = 1ul << 30; // 1 GiB
    print_rss("start");
    char *p = malloc(size);
    if (!p) return 1;
    print_rss("after malloc");
    memset(p, 1, size);      // 모든 페이지에 실제 쓰기
    print_rss("after memset");
    free(p);
    return 0;
}
```

예상되는 관찰: 시작 시점과 `malloc` 직후의 VmRSS는 수 MiB 수준으로 거의 같다 — 1GiB를 "할당"했지만 지급된 것이 없다. `memset` 후에야 VmRSS가 1GiB 이상으로 뛴다. 쓰기가 262,144번(1GiB/4KiB)의 minor fault를 일으키며 페이지를 지급받은 것이고, `/usr/bin/time -v ./demand`로 실행하면 minor fault 수가 대략 그 자릿수로 찍히는 것을 확인할 수 있다.

이 게으름은 낭비 제거이기도 하다. 프로그램이 잡아 놓고 안 쓰는 영역(스레드 스택 기본 8MiB가 대표적 — [8.1](./01-processes-and-scheduling.md)의 thread-per-connection 비용 논의에서 "가상 8MiB, 실제는 쓴 만큼"인 이유)은 물리 메모리를 소비하지 않는다.

### mmap — 파일과 익명, 두 종류의 약속

`mmap(2)`은 주소 공간에 약속을 추가하는 일반 인터페이스이고, 약속의 대상에 따라 둘로 나뉜다.

- **파일 매핑**: 가상 주소 구간을 파일 내용에 연결한다. 접근하면 폴트 핸들러가 해당 파일 페이지를 **페이지 캐시**에서 (없으면 디스크에서 읽어 — major fault) 가져와 매핑한다. 실행 파일과 공유 라이브러리 로딩이 이 메커니즘이고, 같은 라이브러리를 쓰는 모든 프로세스가 같은 물리 페이지를 공유한다. 페이지 캐시 자체는 [8.3](./03-file-systems-and-io.md)의 주제다 — 여기서는 "파일 매핑 = 페이지 캐시를 주소 공간에 노출하는 것"이라는 연결만 세운다.
- **익명(anonymous) 매핑**: 뒤에 파일이 없는 순수 메모리 약속. `malloc`이 큰 할당에 쓰는 것이 이것이다. glibc malloc은 작은 할당은 `brk`로 늘린 힙 영역에서 잘라 주고, 큰 할당(기본 임계 128KiB)은 `mmap`으로 직접 받는다. 할당자가 그 위에서 어떻게 동작하는지 — 그리고 `free`가 왜 곧바로 RSS를 줄이지 않는지 — 는 챕터 6(런타임과 메모리)의 메모리 관리 문서가 담당하는 경계다. 이 문서가 담당하는 절반은 커널 쪽이다: **할당자가 무엇을 하든, 물리 페이지는 접근 시점에 지급되고 RSS는 그 지급량을 센다.**

### copy-on-write — fork가 싼 이유

[8.1](./01-processes-and-scheduling.md)에서 fork는 주소 공간을 "복제"한다고 했다. 실제로 복사되는 것은 페이지 테이블(장부)뿐이다. 커널은 부모와 자식의 매핑이 **같은 물리 페이지**를 가리키게 하고, 양쪽 모두에서 그 페이지들을 쓰기 금지로 표시한다. 어느 쪽이든 쓰려는 순간 쓰기 보호 폴트가 발생하고, 핸들러가 그때서야 페이지를 복사해 쓴 쪽에 배정한다 — **copy-on-write(CoW)**다. 읽기만 하는 페이지는 영원히 공유된다.

fork+exec 경로(셸이 명령을 실행할 때마다)에서 이 게으름은 결정적이다. 자식이 곧바로 exec으로 주소 공간을 통째로 버릴 텐데 전체 복사는 순수 낭비이기 때문이다. 반면 CoW의 계산서가 날아오는 시나리오도 있다. 메모리를 많이 쓰는 프로세스가 fork로 스냅샷을 뜨는 패턴(Redis의 BGSAVE가 유명하다)에서, fork 자체는 빨리 끝나지만 이후 부모가 쓰기를 계속하면 쓰는 페이지마다 복사가 일어나 **물리 메모리 사용량이 최악의 경우 두 배까지 자란다**. "fork는 싸다"는 "쓰기 전까지는"이라는 조건부다.

관찰 예제 — RSS는 공유를 보여주지 못하므로(공유 페이지도 양쪽 RSS에 전부 잡힌다) 공유를 나눠 세는 PSS로 관찰한다:

```c
// cow.c — fork 직후와 자식이 쓴 후의 Rss/Pss 변화를 관찰한다
// 빌드: gcc -O2 cow.c -o cow
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static void print_mem(const char *label) {
    FILE *f = fopen("/proc/self/smaps_rollup", "r");
    char line[256];
    while (fgets(line, sizeof line, f))
        if (strncmp(line, "Rss", 3) == 0 || strncmp(line, "Pss:", 4) == 0)
            printf("%-16s %s", label, line);
    fclose(f);
}

int main(void) {
    size_t size = 512ul << 20; // 512 MiB
    char *p = malloc(size);
    memset(p, 1, size);            // 부모가 전부 지급받는다
    print_mem("parent before");

    if (fork() == 0) {             // 자식
        print_mem("child inherit");
        memset(p, 2, size / 2);    // 절반에만 쓴다 → 그만큼만 복사
        print_mem("child wrote");
        _exit(0);
    }
    wait(NULL);
    return 0;
}
```

예상되는 관찰: fork 직후 자식의 Rss는 부모와 같은 ~512MiB지만 Pss는 절반 수준(~256MiB)이다 — 모든 페이지가 두 프로세스에 공유되고 있어서다. 자식이 절반에 쓰고 나면 그 256MiB는 자식의 사유 페이지가 되어 자식 Pss가 ~384MiB(사유 256 + 공유 256의 절반)로 올라간다. 시스템 전체의 물리 사용량 증가는 정확히 "쓴 만큼"인 256MiB다.

### overcommit과 OOM killer — 약속이 지급 능력을 초과할 때

demand paging의 논리적 귀결이 하나 있다. 할당이 장부 기입일 뿐이라면, 커널은 **지급 능력(물리 메모리 + 스왑)보다 많은 약속**을 해 줄 수 있다. Linux는 기본적으로 그렇게 한다 — **overcommit**이다(`/proc/sys/vm/overcommit_memory`, 기본값 0은 "명백히 과도한 요청만 거부하는 휴리스틱", 1은 무제한 승인, 2는 총량 기반 엄격 관리).

overcommit이 성립하는 이유는 대부분의 프로그램이 약속받은 것을 다 쓰지 않기 때문이다(희소한 자료구조, 안 쓰는 스택, CoW로 공유 중인 페이지). 이 덕에 `malloc`은 거의 실패하지 않고, fork는 "부모 메모리만큼의 여유"를 요구하지 않는다.

청구서는 지급 시점에 온다. 모두가 약속을 이행하라고 요구해서(폴트) 물리 메모리와 스왑이 바닥나면, 커널은 지급할 수 없는데 실패시킬 `malloc` 호출도 없다 — 폴트는 임의의 메모리 접근에서 일어나므로. 남은 수단이 **OOM killer**다. 커널은 프로세스별 점수(`/proc/<pid>/oom_score`, 대체로 메모리 점유 비중 기반)에 조정값(`oom_score_adj`, -1000~1000)을 더해 희생자를 골라 SIGKILL한다. 실무 함의 두 가지: (1) **`malloc` 성공을 메모리 확보로 믿으면 안 된다** — 죽는 시점은 할당이 아니라 접근이고, 죽는 프로세스는 원인 제공자가 아닐 수 있다. (2) 중요한 프로세스는 `oom_score_adj`로 보호하고, 죽어도 되는 캐시성 프로세스에 양보시키는 것이 운영 수단이다. 컨테이너의 메모리 제한(cgroup)은 이 판정을 "시스템 전체"가 아니라 "cgroup 안"에서 반복한다 — 호스트는 여유로운데 컨테이너만 OOM kill되는 이유이며, 상세는 챕터 12(가상화와 클라우드)에서 다룬다.

### 스왑과 thrashing — 축출의 경제학

물리 메모리가 부족해지면 커널은 페이지를 회수(reclaim)한다. 회수 대상은 두 부류이고 비용이 다르다.

- **파일 페이지(페이지 캐시)**: 디스크에 원본이 있으므로, 수정 안 된(clean) 페이지는 그냥 버리면 된다. 가장 싼 회수 대상이다.
- **익명 페이지**(힙, 스택): 디스크에 원본이 없으므로 버릴 수 없고, 내보내려면 **스왑**에 써야 한다. 스왑이 없으면 익명 페이지는 회수 불가능하고, 회수 압박은 전부 페이지 캐시와 OOM killer로 향한다.

여기서 통념 하나를 교정하자. **"스왑 사용량 > 0은 장애 신호"가 아니다.** 오랫동안 접근되지 않은 익명 페이지(초기화 후 안 쓰는 영역 등)를 스왑으로 내보내고 그 물리 페이지를 활발한 파일 캐시에 주는 것은 합리적 배치다. 문제는 스왑에 있는 양이 아니라 **움직임**이다 — `vmstat`의 `si`/`so`(swap in/out)가 지속적으로 0이 아니라면, 프로세스들이 지금 쓰는 페이지가 쫓겨나고 다시 불려오기를 반복한다는 뜻이다.

그 극단이 **thrashing**이다. 활발히 쓰이는 페이지 집합(working set)의 총합이 물리 메모리를 넘으면, 회수가 곧 "곧 다시 쓸 페이지의 축출"이 되고, 접근마다 major fault, 폴트마다 다른 페이지의 축출이라는 연쇄에 들어간다. CPU는 놀면서(모두가 I/O 대기) 시스템은 거의 멈춘다 — [8.1의 load average](./01-processes-and-scheduling.md)가 높은데 CPU가 노는 패턴의 메모리판이다. 진단은 `vmstat`의 지속적 `si`/`so`, `sar -B`의 major fault 비율, `/proc/pressure/memory`(PSI)로 한다. 대응은 working set 축소(메모리 증설, 워크로드 분산, 캐시 축소)뿐이고, 스왑을 없애는 것은 thrashing을 "느려짐"에서 "즉사(OOM)"로 바꾸는 것에 가깝다.

### "메모리 사용량"이라는 숫자들이 각각 세는 것

이제 지표를 정확히 읽을 수 있다.

| 지표 | 어디서 | 세는 것 | 함정 |
|------|--------|---------|------|
| VSZ (virtual) | `ps`, `/proc/<pid>/status`의 VmSize | 약속의 총량 (모든 VMA 크기 합) | 지급과 무관. 수 GiB여도 정상일 수 있다 |
| RSS (resident) | `ps`, VmRSS | 지급된 물리 페이지 (공유 포함 전부) | 프로세스들의 RSS 합 > 실제 사용량 (공유 중복 계산) |
| PSS (proportional) | `/proc/<pid>/smaps_rollup` | RSS에서 공유 페이지를 공유자 수로 나눈 값 | 합산 가능한 유일한 프로세스별 지표. 읽기 비용이 있다 |
| 페이지 캐시 | `free`의 buff/cache | 파일 페이지로 쓰인 물리 메모리 | "사용 중"처럼 보이지만 대부분 즉시 회수 가능 |
| available | `free`, `/proc/meminfo`의 MemAvailable | 스왑 없이 새 워크로드에 줄 수 있는 양의 추정 | free(진짜 빈)와 다르다. **부족 판단은 이 값으로** |

가장 흔한 오판 두 가지. 첫째, `free`의 "free가 거의 0"을 메모리 부족으로 읽는 것 — 건강한 시스템은 남는 메모리를 페이지 캐시로 쓰므로 free는 원래 작다. 볼 값은 **available**이다. 둘째, VSZ 증가를 leak으로 읽는 것 — 약속만 쌓인 것일 수 있다. leak 판단은 RSS(정확히는 PSS)의 **단조 증가 추세**로 하고, 그마저 할당자 보유분(free된 메모리를 커널에 반납하지 않고 재사용을 위해 들고 있는 것 — 챕터 6의 할당자 문서 범위) 때문에 계단형 증가-평탄 패턴과 구분해야 한다.

## 실무 관점

### major fault — 지연 스파이크의 조용한 범인

평소 빠르던 요청이 간헐적으로 수십 ms 걸린다면 후보 목록에 major fault를 넣어야 한다. 전형적 시나리오: (1) 배포 직후 — 실행 파일·라이브러리 페이지가 아직 캐시에 없어 코드 경로 곳곳에서 major fault. (2) 메모리 압박 후 — 한동안 안 쓰인 페이지(드물게 타는 코드 경로, 오래된 캐시 엔트리)가 축출됐다가 접근 시 되돌아옴. (3) mmap 기반 스토리지 접근 — 캐시에 없는 영역을 처음 읽는 쿼리만 느림. 진단: `pidstat -r 1`로 프로세스별 majflt/s를 지연 스파이크 시점과 대조하고, `/usr/bin/time -v`나 `getrusage(2)`로 구간별 폴트 수를 잰다.

### 컨테이너의 메모리 제한과 OOM

컨테이너 환경에서 "메모리 사용량"은 한 겹 더 꼬인다. cgroup의 메모리 계정에는 프로세스의 익명 페이지뿐 아니라 **그 cgroup이 일으킨 페이지 캐시도 포함**된다. 파일 I/O가 많은 컨테이너는 애플리케이션 힙이 작아도 계정상 사용량이 limit에 붙어 다니고, limit에 도달하면 커널은 먼저 그 cgroup의 캐시를 회수한다 — "limit 근처에서 도는 것"이 곧 위험은 아니다. 위험 신호는 사용량 자체가 아니라 회수 실패(cgroup 내 OOM kill 발생 이력, memory PSI 상승)다. 상세 메커니즘은 챕터 12로 위임하고, 여기서는 원칙만: **컨테이너 메모리 지표를 읽을 때는 익명/파일 구분(cgroup v2의 `memory.stat`)까지 내려가야 오판하지 않는다.**

### leak처럼 보이지만 아닌 것 체크리스트

RSS 증가 신고가 들어왔을 때, "진짜 leak"으로 결론 내리기 전에 배제할 것들:

1. **demand paging의 자연 성장** — 시작 직후 RSS는 아직 안 만진 페이지만큼 작다. 워밍업 후 평탄해지면 정상.
2. **할당자 보유분** — free 후에도 할당자가 페이지를 쥐고 있어 RSS가 안 내려간다. 부하 피크 후 평탄 유지가 전형적 모양새 (챕터 6에서 상세).
3. **페이지 캐시 혼동** — 컨테이너 지표가 캐시를 포함해 세고 있는 경우.
4. **CoW 이행** — fork 기반 워커/스냅샷에서 부모의 쓰기가 진행되며 공유가 풀리는 만큼 RSS 합계가 자라는 경우.

이들을 배제한 뒤에도 PSS가 단조 증가하면 그때 힙 프로파일링(챕터 6)으로 내려간다.

### 관찰 — 파일 읽기의 major/minor fault

```c
// mmap-read.c — 파일을 mmap으로 읽고 폴트 수를 확인한다
// 빌드: gcc -O2 mmap-read.c -o mmap-read
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int fd = open(argv[1], O_RDONLY);
    struct stat st;
    fstat(fd, &st);
    unsigned char *p = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    unsigned long sum = 0;
    for (off_t i = 0; i < st.st_size; i += 4096) sum += p[i]; // 페이지마다 한 번 접근
    printf("sum=%lu\n", sum);
    return 0;
}
```

```sh
dd if=/dev/urandom of=data.bin bs=1M count=512
sync && echo 3 > /proc/sys/vm/drop_caches   # 페이지 캐시 비우기 (root 필요. 컨테이너에서는 호스트 커널 설정이라 특권 없이는 불가)
/usr/bin/time -v ./mmap-read data.bin        # 1회차
/usr/bin/time -v ./mmap-read data.bin        # 2회차
```

예상되는 관찰: 1회차는 major fault가 수천~수만(read-ahead가 여러 페이지를 묶어 오므로 페이지 수 131,072보다 훨씬 적다), 2회차는 major가 0에 가깝고 minor만 남는다 — 파일이 이미 페이지 캐시에 있어 매핑만 하면 되기 때문이다. 같은 코드, 같은 데이터에서 폴트의 **종류**가 바뀌고, 그것이 실행 시간 차이로 나타난다. 이 페이지 캐시의 동작이 다음 문서 [8.3](./03-file-systems-and-io.md)의 출발점이다.

## 더 깊이

### 페이지 회수의 구조 — kswapd와 direct reclaim

회수는 두 경로로 일어난다. 백그라운드의 **kswapd**는 가용 메모리가 임계(watermark) 아래로 내려가면 미리 회수를 시작해 여유를 만들어 둔다. 그런데 할당 속도가 회수 속도를 앞지르면, 메모리를 요청한 태스크 **자신이** 할당 경로 안에서 회수를 수행한다 — **direct reclaim**이다. direct reclaim은 할당 지연으로 직접 전가되므로(수십 ms의 할당이 관찰되기도 한다), "메모리가 남아 보이는데 간헐적으로 느리다"의 원인 중 하나다. 회수 후보 선정은 LRU 근사(active/inactive 리스트)로 하고, 익명/파일 페이지 간 균형을 `vm.swappiness`가 조정한다. 이 구간의 관찰 도구가 PSI다 — `/proc/pressure/memory`의 full 값은 "모든 태스크가 동시에 회수에 묶인 시간"으로, thrashing의 정량 신호다.

### 5단계 페이지 테이블과 주소 공간의 미래

48비트(256TiB)로 부족한 대규모 메모리 시스템을 위해 x86-64는 5단계 테이블(57비트, 128PiB)을 지원하고, Linux는 이를 선택적으로 켠다. 단계가 늘면 walk 비용도 는다 — TLB와 페이지 구조 캐시(page-structure cache)가 그 비용을 흡수하는 구조는 같다. 방향만 기억하면 된다: **주소 공간이 커질수록 변환 트리는 깊어지고, huge page 같은 "트리를 얕게 쓰는" 기법의 가치가 커진다.**

## 정리

- 가상 메모리는 프로세스별 변환 테이블 한 겹으로 격리·연속성 착시·공유를 동시에 얻는다. 변환 비용은 TLB가 흡수하고, TLB 커버리지를 넘는 working set은 walk 비용을 지불한다.
- 할당(VMA 기입)은 약속이고 지급은 첫 접근의 페이지 폴트에서 일어난다. 디스크 I/O가 없는 minor fault와 있는 major fault는 자릿수가 다른 비용이며, major fault는 지연 스파이크의 단골 원인이다.
- fork는 페이지 테이블만 복사하고 물리 페이지는 CoW로 공유한다 — 쓰기 전까지 싸고, 쓰기 많은 스냅샷 패턴에서는 메모리가 두 배까지 자랄 수 있다.
- Linux는 지급 능력보다 많이 약속한다(overcommit). 파산 처리는 OOM killer의 몫이고, malloc 성공은 메모리 확보를 의미하지 않는다.
- 스왑 사용량은 신호가 아니고 스왑의 지속적 움직임(si/so)이 신호다. working set이 물리 메모리를 넘으면 thrashing으로 급락한다.
- VSZ는 약속, RSS는 지급(공유 중복 포함), PSS는 공유를 나눈 지급, 페이지 캐시는 회수 가능한 파일 페이지다. 부족 판단은 free가 아니라 available로 한다.

## 확인 문제

**1.** 모니터링 대시보드에서 어떤 서비스의 VSZ가 14GiB, RSS가 900MiB다. 신입 동료가 "가상 메모리를 14GiB나 쓰니 leak"이라고 주장한다. 이 숫자들만으로 알 수 있는 것과 알 수 없는 것을 구분하고, leak 여부를 판정하는 절차를 설계하라.

::: details 정답과 해설
알 수 있는 것: 이 프로세스는 14GiB를 약속받았고(VMA 총합 — 스레드 스택, 안 쓰는 mmap 영역, 할당자가 예약한 arena 등이 흔한 구성이다) 그중 900MiB만 물리로 지급받았다. 알 수 없는 것: leak 여부. leak은 "도달 불가능해진 메모리가 회수되지 않고 쌓이는 것"이므로 시점 단면이 아니라 추세로 판정한다. 절차: (1) 같은 부하 조건에서 RSS(가능하면 smaps_rollup의 PSS)를 시계열로 수집한다. (2) 워밍업(demand paging 자연 성장)과 할당자 보유분(피크 후 평탄)을 배제하기 위해 부하 사이클 여러 번에 걸쳐 본다 — 사이클마다 바닥이 단조 상승하면 leak 후보다. (3) 확증은 힙 프로파일러로 할당 지점을 추적한다(챕터 6의 영역). VSZ 자체는 64비트 주소 공간에서 사실상 공짜이므로 크다는 것만으로는 문제가 아니다.
:::

**2.** 다음 `vmstat 1` 스냅샷을 해석하라. 메모리 4GiB 서버다: `r=1, b=6, swpd=1.2GB, free=90MB, si=850, so=900, us=5, sy=8, id=3, wa=84`. 무슨 상태이고, "스왑을 꺼서 해결하자"는 제안은 어떤 결과를 낳겠는가?

::: details 정답과 해설
si/so가 초당 수백 페이지로 **지속되고** wa(I/O 대기) 84%, b=6(uninterruptible 다수), CPU는 놀고 있다 — 전형적인 thrashing이다. working set 총합이 물리 4GiB를 초과해서, 지금 쓰이는 페이지들이 서로를 밀어내며 swap in/out을 반복하고 있다. free가 90MB인 것은 원인이 아니라 결과다(회수가 계속 도는 중). 해결은 working set 축소 — 메모리 증설, 워크로드 이전, 애플리케이션 캐시 축소 — 뿐이다. 스왑을 끄면 익명 페이지의 회수 수단이 사라져 압박이 페이지 캐시 축출과 OOM killer로 향한다. 즉 "느리지만 돌아가는" 상태가 "프로세스가 죽는" 상태로 바뀔 뿐, working set 초과라는 원인은 그대로다.
:::

**3.** Redis처럼 fork로 스냅샷을 뜨는 데이터 저장소가 있다. 힙이 6GiB이고 머신 물리 메모리는 8GiB다. 평소에는 문제없다가, 쓰기 트래픽이 높은 시간대의 스냅샷 중에만 OOM kill이 발생한다. 메커니즘을 설명하고 대응 방향을 두 가지 이상 제시하라.

::: details 정답과 해설
fork 직후 부모·자식은 6GiB를 CoW로 공유하므로 추가 비용이 거의 없다. 그러나 스냅샷이 진행되는 동안 부모가 쓰기를 계속하면 쓰는 페이지마다 복사가 일어나 사유화된다. 쓰기 트래픽이 높으면 스냅샷 시간 동안 수 GiB가 복제되어 총 물리 수요가 8GiB를 넘고, 폴트(지급) 시점에 커널이 지급 불능이 되어 OOM killer가 발동한다 — overcommit 정책상 fork 시점이 아니라 쓰기 시점에 터진다는 것이 핵심이다. 대응: (1) 쓰기가 적은 시간대로 스냅샷을 스케줄링하거나 쓰기 유입을 스냅샷 동안 제한해 CoW 이행량을 줄인다. (2) 물리 메모리에 최대 CoW 이행분의 여유를 확보한다(힙을 물리의 절반 이하로 운영하는 보수적 규칙이 여기서 나온다). (3) fork 스냅샷 대신 증분 방식(AOF 류)을 쓰거나 복제본에서 스냅샷을 뜬다. (4) 보조 수단으로 스왑을 두어 순간 초과를 흡수하게 하고 oom_score_adj로 본체를 보호한다 — 단 지연 스파이크는 감수해야 한다.
:::

## 참고 자료

- Remzi Arpaci-Dusseau, Andrea Arpaci-Dusseau, [*Operating Systems: Three Easy Pieces*](https://pages.cs.wisc.edu/~remzi/OSTEP/) — 13~23장(주소 공간, 페이징, TLB, 스왑). 이 문서의 변환·정책 모델 전체의 뼈대.
- man pages: [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html) — 파일/익명 매핑의 공식 의미론, [fork(2)](https://man7.org/linux/man-pages/man2/fork.2.html) — CoW 언급 포함, [proc_pid_smaps(5)](https://man7.org/linux/man-pages/man5/proc_pid_smaps.5.html) — Rss/Pss 필드의 정의.
- kernel.org 문서: [Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html) — overcommit_memory 세 모드의 공식 설명, [Concepts overview (mm)](https://docs.kernel.org/admin-guide/mm/concepts.html) — 페이지 캐시·익명 메모리·reclaim의 커널 관점 개관, [PSI](https://docs.kernel.org/accounting/psi.html) — memory pressure 지표.
- [`/proc/meminfo` 문서](https://docs.kernel.org/filesystems/proc.html) — MemAvailable의 계산 의도.
- Brendan Gregg, *Systems Performance* 2nd ed. (2020) — 7장 Memory. 지표 해석, 회수 동작, 진단 방법론.
- Ulrich Drepper, [What Every Programmer Should Know About Memory](https://people.freedesktop.org/~drepper/cpumemory.pdf) — TLB·페이지 테이블의 하드웨어 쪽 상세(챕터 7과 공유하는 참고 자료).
