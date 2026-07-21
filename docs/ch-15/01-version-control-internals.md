# 15.1 버전 관리의 내부 — 내용 주소 그래프가 협업 기록을 만든다

Git을 `add`·`commit`·`push`·`merge` 같은 명령어의 레시피로 익히면 conflict, detached HEAD, "리베이스했더니 히스토리가 사라졌다" 같은 상황에서 판단이 멈춘다. Git은 사실 네 종류의 객체와 그 객체를 가리키는 참조로 이루어진 매우 단순한 데이터 모델이고, 모든 명령은 이 모델 위의 연산이다. 이 문서는 모델을 plumbing 명령으로 직접 관찰하고, 머지·리베이스·reset을 그래프 연산으로 예측하며, 브랜치 전략을 통합 빈도의 트레이드오프로 판단한다.

> 이 문서의 명령 예제는 Git 2.50.1(Apple Git-155) 기준이며, 재현을 위해 author·committer 이름과 날짜를 고정한 빈 저장소에서 실행했다. blob·tree 해시는 내용에만 의존하므로 환경과 무관하게 동일하지만, commit 해시는 author·committer·날짜·메시지에 의존하므로 값이 달라진다.

## 학습 목표

- Git의 네 객체(blob·tree·commit·tag)와 내용 주소 저장으로 커밋 그래프의 구조와 무결성을 설명한다.
- 브랜치·태그·HEAD가 참조(pointer)일 뿐임을 근거로 브랜치 생성·reset·머지·리베이스의 동작을 예측한다.
- 3-way merge와 rebase가 커밋 그래프를 바꾸는 방식의 차이와 트레이드오프를 판단한다.
- 브랜치 전략(trunk-based·GitHub flow·git-flow)을 통합 빈도와 배포 모델의 트레이드오프로 선택한다.

## 배경: "왜 이렇게 머지됐지"는 명령어를 외워서는 못 푼다

버전 관리의 근본 문제는 [인트로](./00-introduction.md)에서 세운 첫 번째 계약이다. 여러 사람이 같은 코드를 동시에 바꿀 때 **"누구의 버전이 진짜이며, 이 두 변경을 어떻게 합치고, 잘못된 변경을 어떻게 찾아 되돌리나"**. Git 이전의 중앙집중식 도구(CVS, Subversion)는 변경을 파일 단위 delta의 순차 번호로 관리했고, 중앙 서버가 진실의 단일 지점이었다. 이 모델은 브랜치·머지가 비싸고, 오프라인 작업이 어렵고, 서버가 이력의 신뢰를 독점했다.

Git은 2005년 리눅스 커널 개발을 위해 다른 전제에서 출발했다. 모든 개발자가 전체 이력의 완전한 복제본을 갖고(분산), 이력의 무결성이 중앙 서버의 권위가 아니라 **암호학적 해시**로 보장되며, 브랜치·머지가 일상 연산이 되도록 값싸야 한다. 이 요구가 지금의 데이터 모델을 만들었다. 표면의 명령어는 이 모델의 편의 계층(porcelain)일 뿐이고, 그 아래 plumbing 명령이 모델을 직접 드러낸다. 모델을 알면 "왜 이렇게 머지됐지"는 외운 규칙이 아니라 그래프 위에서 예측되는 결과가 된다.

## 핵심 개념

### 네 개의 객체와 내용 주소 저장

Git 저장소의 `.git/objects/`에는 네 종류의 객체가 있고, 각 객체의 이름은 **그 내용의 SHA-1 해시**다.

- **blob**: 파일의 내용. 파일명도 권한도 없이 바이트 시퀀스만 담는다.
- **tree**: 디렉터리. 이름 → (권한, blob 또는 하위 tree 해시)의 목록.
- **commit**: 하나의 tree(스냅샷) + 부모 commit(들) + 작성자·커미터·메시지.
- **tag**: 특정 객체(보통 commit)에 대한 이름표 + 서명(annotated tag).

plumbing으로 직접 만들어 보자. `git hash-object`는 내용을 받아 그 해시를 계산한다.

```console
$ printf 'hello\n' | git hash-object --stdin
ce013625030ba8dba906f756967f9e9ca394464a
```

이 해시는 마법이 아니다. Git은 `<타입> <바이트길이>\0<내용>` 형태에 SHA-1을 적용한다. 손으로 재현할 수 있다.

```console
$ printf 'blob 6\0hello\n' | shasum
ce013625030ba8dba906f756967f9e9ca394464a  -
```

`hello\n`은 6바이트이므로 헤더가 `blob 6\0`이고, 그 해시가 `git hash-object`의 결과와 정확히 일치한다. **객체의 이름이 곧 내용의 지문**이라는 이 성질을 내용 주소 지정(content-addressable storage)이라 한다. 파일을 커밋하고 객체들을 들여다보면 네 객체가 서로를 해시로 가리키는 구조가 드러난다.

```console
$ echo "hello" > greeting.txt && git add greeting.txt && git commit -m "add greeting"

$ git cat-file -p HEAD              # commit 객체
tree 57e9529754dc514a3ec10db2ff882018fbe1fcbf
author Dev <dev@example.com> 1784682000 +0900
committer Dev <dev@example.com> 1784682000 +0900

add greeting

$ git cat-file -p HEAD^{tree}       # 그 commit이 가리키는 tree
100644 blob ce013625030ba8dba906f756967f9e9ca394464a	greeting.txt

$ git cat-file -p HEAD:greeting.txt # 그 tree가 가리키는 blob
hello
```

commit은 tree를 해시로 가리키고, tree는 blob을 해시로 가리킨다. 각 이름이 내용의 해시이므로, 어느 단계의 한 바이트라도 바뀌면 그 객체의 해시가 바뀌고, 그것을 가리키던 상위 객체의 해시도 연쇄적으로 바뀐다. 이 구조가 바로 **Merkle DAG**(방향성 비순환 그래프)이며([챕터 1의 해시](../ch-1/02-data-structures-in-memory.md), [챕터 3의 해시 함수](../ch-3/02-symmetric-crypto-and-integrity.md) 참조), 이력의 무결성이 여기서 나온다. 커밋 해시 하나를 신뢰하면 그 커밋이 도달하는 전체 트리와 조상 이력 전부의 무결성이 함께 보장된다. 중간의 어떤 파일을 몰래 바꾸면 커밋 해시부터 달라지기 때문이다. Git이 "서버를 신뢰하지 않아도 이력을 신뢰할 수 있는" 이유가 이것이다.

객체는 zlib로 압축되어 해시의 앞 2자를 디렉터리로 하는 경로에 저장된다.

```console
$ ls .git/objects/ce/
013625030ba8dba906f756967f9e9ca394464a
```

### 커밋은 스냅샷이고, diff는 그때그때 계산된다

흔한 오해는 "커밋이 diff(변경분)를 저장한다"는 것이다. 위 tree 출력이 보여주듯 커밋은 **그 시점의 전체 트리 스냅샷**을 가리킨다. `git show`나 `git diff`가 보여주는 변경분은 저장된 것이 아니라 **두 트리를 비교해 표시 시점에 계산**한 결과다.

이 사실이 여러 동작을 설명한다. 파일 하나만 바꾼 커밋도 개념상 전체 트리를 새로 가리키지만(바뀌지 않은 blob·tree는 이전 해시를 그대로 재사용하므로 실제 새 객체는 바뀐 경로만 생긴다), 저장 효율은 packfile의 delta 압축이 따로 담당한다. 파일 이름을 바꾼 커밋에도 "rename"이라는 정보는 저장되지 않는다. Git은 두 트리에 내용이 같은 blob이 다른 이름으로 나타난 것을 보고 rename을 **추정**할 뿐이다(`git diff -M`). 스냅샷 모델은 "이력의 각 지점에서 프로젝트 전체 상태가 무엇이었나"를 O(1)에 복원하게 하고, 그 대가로 변경 의도(rename, move)는 계산·추정의 대상으로 남긴다.

### 참조: 브랜치·HEAD·태그는 커밋을 가리키는 파일이다

객체 그래프는 불변이고 내용으로 이름 붙는다. 그렇다면 "현재 브랜치", "main의 최신 커밋" 같은 **움직이는 이름**은 어디에 있나. `.git/refs/`의 참조(ref)다. 참조는 커밋 해시를 담은 40바이트 텍스트 파일에 불과하다.

```console
$ cat .git/refs/heads/main
78d5e44c75db03432e4bf3f5edefe025f9b7db3b

$ cat .git/HEAD
ref: refs/heads/main
```

`main`이라는 브랜치는 커밋 해시 하나를 적은 파일이고, `HEAD`는 "지금 어느 브랜치에 있나"를 가리키는 간접 참조(symbolic ref)다. 이 단순한 사실에서 Git의 여러 동작이 곧바로 따라온다.

- **브랜치 생성이 O(1)인 이유**: 새 브랜치는 파일 하나를 쓰는 일이다. 커밋을 복사하지 않는다.

  ```console
  $ git branch feature
  $ cat .git/refs/heads/feature
  78d5e44c75db03432e4bf3f5edefe025f9b7db3b   # main과 같은 커밋을 가리킴
  ```

- **커밋의 의미**: 현재 브랜치 참조가 가리키는 커밋을 부모로 하는 새 커밋을 만들고, 참조를 새 커밋으로 **전진**시킨다.
- **`git reset`의 의미**: 작업 트리를 건드리는 것이 아니라(옵션에 따라 다르지만) 본질은 **현재 브랜치 참조를 다른 커밋으로 옮기는 것**이다. `reset --hard HEAD~1`은 "브랜치 파일에 부모 커밋 해시를 덮어쓰기"다. 커밋 자체는 지워지지 않는다.
- **detached HEAD**: `HEAD`가 브랜치가 아니라 커밋을 직접 가리키는 상태. 이때 만든 커밋은 어떤 브랜치도 가리키지 않아, 브랜치를 옮기면 참조를 잃는다.

참조를 옮기는 모든 조작은 `.git/logs/`의 **reflog**에 기록된다. reflog는 "잃어버린" 커밋을 되찾는 안전망이다.

```console
$ git reset --hard HEAD~1       # 방금 커밋을 버린 것처럼 보인다
$ git log --oneline -n 1
6abf5d2 merge feature into main

$ git reflog -n 3
db201d3 HEAD@{2}: rebase (finish): returning to refs/heads/topic2
783d1d9 HEAD@{1}: checkout: moving from topic2 to main
6abf5d2 HEAD@{0}: reset: moving to HEAD~1
```

`reset`으로 브랜치가 이전 커밋을 더는 가리키지 않아도, 그 커밋 객체는 여전히 존재하고 reflog가 그 해시를 기억한다. `git reset --hard <해시>`나 `git checkout -b rescue <해시>`로 복구할 수 있다. 도달 불가능한 객체가 실제로 삭제되는 것은 한참 뒤 `git gc`가 돌 때뿐이다. "Git에서 커밋을 잃었다"는 대부분 참조를 잃은 것이지 객체를 잃은 것이 아니다.

### 머지: 공통 조상을 기준으로 세 트리를 합친다

두 브랜치가 갈라져 각자 커밋을 쌓았을 때, 그 둘을 합치는 것이 머지다. 핵심은 **merge base**, 즉 두 브랜치의 가장 가까운 공통 조상이다.

```console
$ git log --all --graph --oneline
* 42b6078 feature: add feature.txt
| * 5cb8833 main: add other.txt
|/
* 21d84ff main: add line A       ← 여기가 merge base
* 78d5e44 add greeting

$ git merge-base main feature
21d84ffdf1ce232b81614f643adc3ce7979ca469
```

Git은 세 지점 — merge base, main의 끝, feature의 끝 — 의 트리를 비교하는 **3-way merge**를 한다. 파일별로 판단한다. 한쪽만 바꾼 파일은 그 변경을 취하고, 양쪽이 **같은 부분**을 다르게 바꾼 파일에서만 conflict를 낸다. 위 예처럼 두 브랜치가 서로 다른 파일을 건드렸다면 충돌 없이 자동 병합되고, 부모가 둘인 **merge commit**이 생긴다.

```console
$ git merge --no-ff feature -m "merge feature into main"
$ git cat-file -p HEAD | grep '^parent'
parent 5cb883398de395cc45e54f52f58d763b3bd61bd4   # main 쪽
parent 42b6078f4a0ef1561a2415437d3e6cd46352eebd   # feature 쪽
```

merge commit이 부모를 둘 가리키므로, 히스토리 그래프에 갈라짐과 합쳐짐이 그대로 남는다. 두 가지 특수 경우를 구분해야 한다.

- **fast-forward**: 대상 브랜치가 현재 브랜치의 직계 후손이면(그 사이 현재 브랜치에 새 커밋이 없으면) merge base가 곧 현재 브랜치의 끝이다. 이때 합칠 것이 없으므로 Git은 새 커밋을 만들지 않고 브랜치 참조만 앞으로 옮긴다. `--no-ff`는 이 경우에도 merge commit을 강제해 "여기서 브랜치가 합쳐졌다"는 기록을 남긴다.
- **conflict**: 양쪽이 같은 라인 영역을 다르게 바꾸면 Git은 자동 판단을 포기하고 충돌 표식(`<<<<<<<`, `=======`, `>>>>>>>`)을 파일에 남긴 뒤 사람에게 넘긴다. conflict는 도구의 실패가 아니라 **"이 결정은 자동화할 수 없다"는 정직한 신고**다.

### 리베이스: 커밋을 다시 쓴다

머지가 두 이력을 **합쳐서** 갈라짐을 기록으로 남긴다면, 리베이스는 한쪽 브랜치의 커밋들을 다른 base 위에 **다시 만들어** 선형 이력을 만든다. 여기서 "다시 만든다"가 핵심이다. 커밋 해시는 내용 + 부모 + 작성자 + 날짜의 함수이므로, 부모가 바뀌면 **같은 변경이라도 해시가 달라진다**.

```console
# topic2 브랜치의 커밋 (부모 = 예전 main)
$ git rev-parse HEAD
601f909db0d61dae58339a0d093ac1d8bf226206

$ git rebase main    # main의 새 끝 위로 커밋을 재생성

# 같은 파일 변경이지만 부모가 바뀌어 해시가 다르다
$ git rev-parse HEAD
db201d3be5bd36b21f7dcfa422a56b7d72d84938
```

리베이스가 만드는 것은 원본 커밋의 **복사본**이고, 원본은 참조를 잃고 reflog에만 남는다. 이 성질이 리베이스의 득실을 모두 설명한다.

- **얻는 것**: 선형 이력. merge commit의 갈라짐 없이 `git log`가 일직선이 되어 읽기 쉽고, `git bisect`가 단순해진다. 리뷰 전 지저분한 중간 커밋을 정리(interactive rebase의 squash·fixup)할 수 있다.
- **잃는 것과 위험**: 이력의 사실성. 실제로는 갈라져 개발됐는데 처음부터 순차였던 것처럼 기록이 바뀐다. 더 심각한 위험은 **이미 공유된 커밋을 리베이스**할 때다. 다른 사람이 원본 해시를 기준으로 작업 중인데 그 해시가 사라지면, 그들의 이력과 재작성된 이력이 충돌해 중복 커밋과 혼란이 생긴다.

여기서 리베이스의 황금률이 나온다. **공유된(push된) 커밋은 리베이스하지 않는다.** 리베이스는 아직 나만 가진 로컬 커밋을 정리하는 도구다. 이미 공개된 커밋을 되돌려야 한다면, 이력을 다시 쓰는 리베이스가 아니라 "되돌리는 변경을 새 커밋으로 추가하는" `git revert`를 쓴다. revert는 이력을 보존하므로 공유된 브랜치에서 안전하다.

### 브랜치 전략: 통합 빈도의 트레이드오프

지금까지의 모델은 "브랜치는 값싸고, 머지는 공통 조상에서, 리베이스는 이력을 다시 쓴다"였다. 이 위에서 팀이 정하는 것이 브랜치 전략이고, 전략의 핵심 변수는 [15.2](./02-development-methodologies.md)에서 프로세스의 핵심 변수로 다시 만나는 **통합 빈도(배치 크기)**다.

| 전략 | 브랜치 구조 | 통합 빈도 | 적합 조건 | 주요 비용 |
|---|---|---|---|---|
| Trunk-based | 하나의 mainline, 수명이 짧은(하루 이하) 브랜치 | 매우 높음 | 성숙한 CI, 기능 플래그, 자주 배포 | 미완성 코드를 숨길 기능 플래그 규율 필요 |
| GitHub flow | main + 기능별 짧은 브랜치 → PR → 머지 | 높음 | 지속적 배포, 리뷰 중심 협업 | 브랜치 수명이 길어지면 통합 지옥 |
| git-flow | main·develop + feature·release·hotfix | 낮음 | 명시적 릴리스 버전, 여러 버전 동시 유지 | 브랜치 종류가 많고 통합이 늦어 머지 비용 큼 |

전략을 가르는 것은 취향이 아니라 **통합을 미룰 때의 비용**이다. 브랜치를 오래 유지할수록 mainline과 멀어지고, 멀어진 브랜치의 머지는 충돌이 크고 위험하다("merge hell"). 이 통합 비용은 브랜치 수명에 대해 선형이 아니라 초선형으로 커진다. 여러 브랜치가 각자 오래 발산하면 서로에 대한 충돌이 조합적으로 늘기 때문이다.

Trunk-based는 이 비용을 **통합을 미루지 않음**으로 회피한다. 모두가 하루에도 여러 번 mainline에 통합하므로 각 통합의 배치가 작고 충돌이 작다. 대신 "아직 완성되지 않은 기능이 mainline에 있으면 어떻게 하나"라는 문제가 생기고, 그 답이 [기능 플래그](../ch-14/03-reliability-engineering.md)다. 코드는 mainline에 통합하되(배포) 기능은 플래그 뒤에 숨겨 노출을 분리(릴리스)한다. 이것이 [인트로](./00-introduction.md)의 조율 계약을 구현하는 방식이며, 성숙한 CI([15.3](./03-devops.md))가 전제되어야 안전하다. 매 통합이 자동 검증되지 않으면 잦은 통합은 잦은 파손이 된다.

git-flow는 반대편이다. 명시적 버전을 릴리스하고 여러 버전을 동시에 유지보수해야 하는 맥락(패키지 소프트웨어, 온프레미스 배포)에서는 release·hotfix 브랜치의 구조가 필요하다. 그러나 하루에도 여러 번 배포하는 웹 서비스에 git-flow를 적용하면 브랜치 종류와 통합 지연이 순수한 오버헤드가 된다. **브랜치 전략은 배포 모델(얼마나 자주, 몇 개 버전을 배포하는가)에서 역산하는 것**이지, 그 반대가 아니다.

## 실무 관점

### "리베이스로 히스토리를 깨끗하게"의 경계

깨끗한 선형 이력은 가치가 있지만, 그 가치는 **아직 공유되지 않은 로컬 커밋**에 한정된다. 공유된 브랜치(main, 다른 사람이 기반으로 삼는 브랜치)를 리베이스하거나 force push하면, 팀 전체의 이력이 어긋난다. 실무의 안전선은 이렇다. 내 PR 브랜치를 리뷰 전에 정리하는 리베이스는 좋다. 이미 남이 pull한 커밋의 리베이스는 금지. force push가 꼭 필요하면 `--force-with-lease`를 써서 "내가 마지막으로 본 상태에서 원격이 바뀌지 않았을 때만" 밀어, 남의 커밋을 덮어쓰는 사고를 막는다.

### squash merge의 득실

많은 팀이 PR을 squash merge(브랜치의 여러 커밋을 하나로 합쳐 머지)한다. 이점은 mainline 이력이 "PR 하나 = 커밋 하나"로 단순해지고 revert 단위가 명확해지는 것이다. 비용은 브랜치 내부의 중간 커밋(디버깅 과정, 개별 단계)이 mainline에서 사라져 세밀한 `git bisect`가 불가능해지는 것이다. 판단 기준은 mainline 이력의 소비자다. 릴리스 단위 revert와 읽기 쉬운 로그가 중요하면 squash, 세밀한 이분 탐색과 각 커밋의 맥락 보존이 중요하면 merge commit 또는 rebase merge를 택한다.

### `git bisect`: 그래프가 있어서 가능한 디버깅

"언제부터 이 버그가 있었나"는 커밋 그래프 위의 이진 탐색으로 O(log n)에 답할 수 있다. `git bisect start`로 나쁜 커밋과 좋은 커밋을 지정하면 Git이 중간 커밋을 골라주고, 각 지점에서 테스트해 good/bad를 알려주면 결함을 도입한 커밋으로 좁혀 간다. `git bisect run <스크립트>`로 자동화하면 수백 커밋을 몇 분에 좁힌다. 이것이 [인트로](./00-introduction.md)에서 말한 "장애를 만든 변경이 어느 커밋인가"가 명령이 아니라 그래프 연산으로 답해지는 사례다. bisect가 잘 작동하려면 각 커밋이 빌드·테스트 가능한 상태여야 하며, 이는 작은 배치·자주 통합과 맞물린다.

### 대형 저장소의 경계

내용 주소 모델은 우아하지만 규모에서 비용이 드러난다. 전체 이력을 복제하는 특성상 이력이 크면 clone이 무거워진다. 대응 수단이 있다. `--depth`로 최근 이력만 받는 shallow clone, 필요한 blob만 지연 로딩하는 partial clone(`--filter=blob:none`), 작업 트리의 일부만 체크아웃하는 sparse-checkout. 대용량 바이너리는 Git LFS로 포인터만 저장하고 실제 파일은 별도 스토리지에 둔다. monorepo(하나의 저장소에 여러 프로젝트)는 통합 빈도와 원자적 변경의 이점을 주지만, 이런 규모 대응 없이는 clone·status·머지 비용이 급증한다. 저장 효율의 근간인 packfile(객체를 delta 체인으로 압축)과 gc는 대개 자동이지만, 저장소가 느려지면 `git gc`·`git repack`이 첫 점검 대상이다.

### SHA-1에서 SHA-256으로

Git의 무결성은 해시 충돌 저항성에 의존하는데, SHA-1은 2017년 SHAttered로 실제 충돌이 시연됐다([챕터 3](../ch-3/02-symmetric-crypto-and-integrity.md)). 다만 Git의 위협 모델에서 이것이 즉각적 위험은 아니다. Git은 충돌 공격을 탐지하는 완화(collision detection)를 적용했고, 커밋 이력의 신뢰는 순수한 해시뿐 아니라 서명(signed commit·tag)과 사회적 검증에도 기댄다. 그럼에도 Git은 SHA-256 저장소 형식을 도입해 전환 경로를 열어 두었다. 2026년 현재 SHA-256 저장소는 사용 가능하지만 호스팅·도구 생태계의 지원이 완전하지 않아 대부분의 저장소는 여전히 SHA-1이다. 새 저장소에서 `git init --object-format=sha256`을 선택할 수 있으나, 협업 대상 도구들의 지원을 먼저 확인해야 한다. 공급망 무결성이 중요하다면 해시 형식보다 **커밋 서명**이 실효적 방어선이다.

## 더 깊이: 커밋 서명과 공급망 신뢰

내용 주소 해시는 "이력이 일관되게 변조되지 않았다"를 보장하지만, "이 커밋을 정말 그 사람이 작성했다"는 보장하지 않는다. author 필드는 자유 텍스트라 누구나 사칭할 수 있다. 이 간극을 메우는 것이 [챕터 3의 디지털 서명](../ch-3/03-asymmetric-crypto-and-key-exchange.md)을 적용한 커밋·태그 서명이다. `git commit -S`는 커밋 객체에 GPG(또는 SSH·X.509) 서명을 붙이고, `git verify-commit`·`git log --show-signature`로 검증한다. 서명된 태그는 릴리스 아티팩트의 출처를 증명하는 표준 수단이다.

이는 [인트로](./00-introduction.md)의 기록 계약을 공급망 수준으로 끌어올린다. 무결성(내용이 안 바뀌었나)에 더해 진위(누가 만들었나)를 검증하면, 악의적 커밋이 이력에 몰래 섞이는 공격면이 줄어든다. 다만 서명은 키 관리·검증 정책·CI 통합이 갖춰져야 실효가 있고, 서명 검증을 강제하지 않으면 서명 자체는 장식이 된다. [15.3](./03-devops.md)에서 다룰 아티팩트 서명·SBOM은 이 원리를 빌드 산출물로 확장한 것이다.

## 정리

- Git은 네 객체(blob·tree·commit·tag)의 Merkle DAG이고, 각 객체의 이름은 `<타입> <길이>\0<내용>`의 SHA-1이다. 커밋 해시 하나를 신뢰하면 그것이 도달하는 전체 트리와 조상 이력의 무결성이 함께 보장된다.
- 커밋은 diff가 아니라 전체 트리 스냅샷을 가리키고, 변경분과 rename은 표시·추정 시점에 계산된다.
- 브랜치·HEAD·태그는 커밋을 가리키는 파일(참조)일 뿐이다. 브랜치 생성이 O(1)인 이유, reset이 참조 이동인 이유, 잃은 커밋이 reflog로 복구되는 이유가 모두 여기서 나온다.
- 머지는 merge base 기준 3-way 병합으로 갈라짐을 기록에 남기고, 리베이스는 커밋을 새 부모 위에 재생성해 해시를 바꾼다. 공유된 커밋은 리베이스하지 않고 revert로 되돌린다.
- 브랜치 전략의 핵심 변수는 통합 빈도다. 통합을 미룰수록 머지 비용이 초선형으로 커지므로, 전략은 배포 모델에서 역산한다. Trunk-based는 잦은 통합 + 기능 플래그 + 성숙한 CI로, git-flow는 명시적 다중 버전 릴리스 맥락으로 정당화된다.

## 확인 문제

1. 동료가 "실수로 `git reset --hard`를 해서 오후 내내 작업한 커밋 3개를 날렸다"며 좌절한다. 아직 `git gc`는 돌지 않았다. 왜 그 커밋들이 대부분 복구 가능한지 Git의 객체·참조 모델로 설명하고, 복구 절차를 제시하라.
2. 어떤 팀이 공유 `develop` 브랜치를 매일 아침 `main` 위로 리베이스하고 force push한다. 매일 아침 팀원들이 로컬 브랜치에서 이상한 충돌과 중복 커밋을 겪는다. 원인을 커밋 해시의 계산 방식으로 설명하고, 같은 목적(develop을 main 최신 상태로 유지)을 안전하게 달성하는 대안을 제시하라.
3. 두 팀이 있다. A팀은 기능 브랜치를 평균 2주간 유지하다 머지하고, B팀은 기능 플래그 뒤에서 하루에도 여러 번 mainline에 머지한다. 두 팀 모두 "머지 충돌이 통합 병목"이라고 호소한다. 각 팀의 충돌이 생기는 구조적 원인이 어떻게 다른지, 그리고 A팀에게 B팀의 방식을 그대로 권하기 전에 확인해야 할 전제를 설명하라.
4. 리뷰어가 "이 PR은 커밋이 15개나 되니 squash해서 머지하자"고 제안한다. 이 저장소는 장애 발생 시 `git bisect`로 원인 커밋을 좁히는 것을 디버깅의 핵심 수단으로 삼는다. squash의 득과 실을 이 맥락에서 판단하고, 절충안을 제시하라.

<details>
<summary>정답과 해설</summary>

1. `git reset --hard`는 커밋 객체를 삭제하지 않는다. 브랜치 참조(`.git/refs/heads/<브랜치>` 파일)를 이전 커밋 해시로 덮어썼을 뿐이다. 세 커밋의 객체는 여전히 `.git/objects/`에 있고, 참조만 잃어 도달 불가능(unreachable) 상태가 됐다. 도달 불가능한 객체는 `git gc`가 만료 기준을 넘겨 정리하기 전까지 남는다. 복구: `git reflog`(또는 `git reflog show HEAD`)로 reset 직전 `HEAD@{1}` 등의 커밋 해시를 찾고, `git reset --hard <그 해시>`로 브랜치를 되돌리거나 `git branch rescue <그 해시>`로 새 브랜치에 붙인다. reflog가 참조 이동을 기록하기 때문에 "참조를 잃은" 대부분의 사고가 복구된다. 진짜로 잃는 경우는 gc가 이미 돌았거나, 애초에 커밋하지 않은 작업 트리 변경(add도 안 한 상태)이다.
2. 리베이스는 커밋을 그 자리에서 옮기지 않고 **재생성**한다. 커밋 해시는 (트리 + 부모 + author + committer + 날짜 + 메시지)의 함수이므로, 부모가 바뀌면 같은 변경이라도 새 해시가 된다. 매일 아침 develop을 리베이스하면 어제의 develop 커밋들이 모두 새 해시로 바뀌고, 옛 해시는 사라진다. 팀원의 로컬 develop은 여전히 옛 해시를 가리키므로, 다음 pull에서 Git은 로컬의 옛 커밋과 원격의 새 커밋을 서로 다른 이력으로 보고 병합하려 해 중복 커밋과 충돌이 생긴다. 원인은 "공유된 커밋을 리베이스했다"는 황금률 위반이다. 안전한 대안: (a) develop을 리베이스하지 말고 main을 develop으로 **머지**한다(이력에 머지 커밋이 남지만 해시가 보존됨). (b) 애초에 오래 사는 develop 브랜치를 두지 않고 trunk-based로 전환해 리베이스할 공유 브랜치 자체를 없앤다. 공유 브랜치 재작성이 정말 필요한 예외 상황이라면 최소한 `--force-with-lease`와 팀 전체 공지·재동기화 절차를 동반해야 한다.
3. A팀의 충돌은 **배치 크기**에서 온다. 2주간 발산한 브랜치는 그동안 mainline이 움직인 만큼, 그리고 다른 2주짜리 브랜치들이 같은 영역을 건드린 만큼 충돌한다. 발산 기간이 길수록 충돌면이 초선형으로 커진다(merge hell). B팀의 충돌은 성격이 다르다. 하루에도 여러 번 통합하므로 각 충돌은 작지만, 통합 빈도가 높아 충돌을 **자주** 만난다 — 다만 각각은 작아서 즉시 해소된다. B팀이 병목이라 느낀다면 그것은 큰 충돌이 아니라 통합·검증 파이프라인의 속도 문제일 가능성이 높다. A팀에게 B팀 방식을 권하기 전 확인할 전제: (1) 성숙한 CI가 있어 매 통합이 자동 검증되는가(없으면 잦은 통합은 잦은 파손). (2) 미완성 기능을 mainline에서 숨길 기능 플래그 규율이 있는가. (3) 배포가 잦고 가역적인가. 이 전제 없이 통합 빈도만 올리면 깨진 mainline과 노출된 미완성 기능이라는 새 문제를 얻는다.
4. squash는 mainline 이력을 "PR = 커밋 하나"로 단순화해 읽기 쉽고 PR 단위 revert가 명확해진다. 그러나 bisect가 핵심 수단인 이 저장소에서는 큰 실이 있다. 15개 커밋이 하나로 합쳐지면 bisect가 그 PR을 "결함 도입 지점"으로 좁혀도, PR 내부의 어느 변경이 원인인지 더 좁힐 수 없다. bisect의 해상도가 PR 단위로 떨어진다. 판단: 이 맥락에서는 무조건 squash가 최선이 아니다. 절충안 — (a) PR 저자가 리베이스로 중간 커밋을 **의미 있는 단위**로 정리하되(디버깅 흔적은 합치고 논리적 단계는 남김) squash하지 않고 머지해, 각 커밋이 빌드·테스트 가능한 상태를 유지한다. 그러면 bisect 해상도를 지키면서 이력의 잡음은 줄인다. (b) 저장소 전체 정책으로 "각 커밋은 독립적으로 빌드·통과해야 한다"를 요구하고 rebase merge를 기본으로 한다. squash는 커밋 위생이 나쁜 PR에 한해 예외적으로 적용한다. 핵심은 mainline 이력의 주 소비자가 bisect라는 사실이 정책을 결정해야 한다는 것이다.

</details>

## 참고 자료

- Scott Chacon, Ben Straub, [Pro Git — Git Internals](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain) — blob·tree·commit·tag 객체와 참조·packfile을 plumbing 명령으로 직접 다루는 1차 자료다.
- [Git Reference Manual — git-cat-file, git-hash-object](https://git-scm.com/docs) — 이 문서의 plumbing 예제(객체 타입·내용 조회, 해시 계산)의 공식 명세다.
- Linus Torvalds, [Git 초기 설계 노트](https://github.com/git/git/blob/master/Documentation/user-manual.txt) 및 Git 소스의 `Documentation/technical/` — 내용 주소 모델과 분산 무결성의 설계 의도를 확인한다.
- [Git SHA-256 전환 문서 (hash-function-transition)](https://git-scm.com/docs/hash-function-transition) — SHA-1→SHA-256 전환의 설계와 현재 상태, 상호 운용 계획을 확인한다.
- Martin Fowler, [Patterns for Managing Source Code Branches](https://martinfowler.com/articles/branching-patterns.html) — trunk-based·feature branch·통합 빈도 트레이드오프를 패턴으로 정리한 자료다.
- Marc Stevens 외, [The first collision for full SHA-1 (SHAttered)](https://shattered.io/) — Git의 해시 무결성 가정과 SHA-256 전환 동기의 배경이다.
