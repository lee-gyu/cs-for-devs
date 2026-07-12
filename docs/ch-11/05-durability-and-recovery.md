# 11.5 내구성과 복구 — 커밋의 의미를 로그 순서로 증명한다

커밋은 수정한 모든 data page를 즉시 제자리에 쓰는 명령이 아니다. 많은 DBMS는 더 작은 순차 로그를 먼저 안정 저장하고 dirty page는 나중에 내보낸다. 이 선택은 정상 경로의 I/O를 줄이는 대신 crash 뒤 committed 변경을 redo하고 미완료 변경을 undo할 복구 절차를 요구한다.

## 학습 목표

- write-ahead logging의 선행 기록 불변식을 page와 log sequence number로 설명한다.
- steal/no-steal과 force/no-force가 정상 I/O와 redo·undo 필요성을 바꾸는 방식을 판단한다.
- commit record, WAL write·flush, group commit과 client acknowledgment 시점을 구분한다.
- checkpoint가 복구 시작 범위와 log 재사용 경계를 줄이는 과정을 설명한다.
- crash point별 durable transaction과 redo·undo 대상을 예측하고 media corruption의 별도 경계를 식별한다.

## 배경: 성공 응답 전에 무엇이 저장되어야 하는가

주문 확정 트랜잭션이 주문 상태와 재고 page를 수정했다고 하자. 매 commit마다 여러 data page를 제자리까지 동기 flush하면 random I/O와 지연이 커진다. 반대로 메모리만 바꾸고 성공을 응답하면 전원 손실 뒤 주문이 사라질 수 있다.

write-ahead logging(WAL)은 변경을 재현하거나 되돌릴 수 있는 log record를 data page보다 먼저 안정 저장한다. commit 시에는 해당 트랜잭션의 commit 결정까지 log를 durable하게 만들고, data page는 background flush할 수 있다.

```text
transaction update
   │
   ├─ append WAL record ──▶ log buffer ──▶ durable log
   │                                          │
   └─ modify buffer page (dirty)               │ WAL first
                         └──────────────────────┴─▶ data file later
```

이 구조에서 “파일에 썼다”와 “안정 저장됐다”는 다른 사건이다. application buffer, DB log buffer, OS page cache, device volatile cache를 거칠 수 있다. DBMS는 운영체제와 장치가 제공하는 flush·ordering 계약을 올바르게 사용해야 내구성을 조립할 수 있다.

## WAL의 두 불변식

log의 위치를 단조 증가하는 log sequence number(LSN)로 나타내자. page는 자신에게 반영된 마지막 log record의 `pageLSN`을 가진다고 단순화한다.

### dirty page 선행 기록

data page를 안정 저장하기 전에 그 page의 변경을 설명하는 log가 먼저 durable해야 한다.

```text
flush(page P) 허용 조건:
durableLSN >= P.pageLSN
```

이를 어기면 data file에는 미완료 transaction의 변경이 있지만 crash 뒤 그것을 식별·undo할 log가 없을 수 있다. WAL buffer를 먼저 flush하거나 page flush를 기다리게 해 순서를 지킨다.

### commit 선행 기록

내구성 있는 commit을 client에 알리기 전에 해당 transaction의 commit record와 필요한 앞선 log가 durable해야 한다.

```text
ACK_COMMIT(T) 허용 조건:
durableLSN >= T.commitLSN
```

제품 설정이 이 경계를 완화해 OS crash나 전원 손실에서 최근 transaction 손실을 허용할 수도 있다. 그 경우 latency를 줄이는 대신 내구성 계약을 바꾼 것이므로 설정 이름이 아니라 어떤 failure에서 얼마나 잃을 수 있는지 명시한다.

## log record와 transaction chain

교육용 physiological WAL record를 단순화하면 다음 정보를 가질 수 있다.

```text
LSN
transaction_id
prevLSN
page_id
redo information
undo information
```

`prevLSN`은 같은 transaction의 이전 record를 가리켜 abort·undo가 역순으로 따라갈 수 있게 한다. `page_id`와 redo 정보는 특정 page 변경을 재적용하는 데 쓴다. 실제 엔진은 physical byte 변화, logical operation 또는 둘을 섞고 full-page image, checksum과 compensation log record를 사용할 수 있다.

redo를 적용할 때 page의 `pageLSN`이 이미 record LSN 이상이면 해당 효과가 반영됐다고 보고 건너뛸 수 있다. 이 멱등성은 recovery 도중 다시 crash해도 재시작 가능한 기반이다.

## steal/no-steal과 force/no-force

buffer 관리 정책은 recovery 요구를 결정한다.

### steal

buffer manager가 아직 commit하지 않은 transaction이 수정한 dirty page를 victim으로 골라 data file에 쓸 수 있다. 작은 buffer와 긴 transaction에서도 frame을 재사용하지만 crash나 abort 시 uncommitted effect가 data file에 있을 수 있어 undo가 필요하다.

### no-steal

미완료 변경 page를 내보내지 않는다. undo 요구를 줄이지만 큰 transaction의 dirty working set을 memory에 유지하거나 별도 구조에 보관해야 한다.

### force

commit 전에 transaction이 수정한 모든 data page를 안정 저장한다. committed data의 redo 요구를 줄이지만 commit latency가 흩어진 page I/O에 묶인다.

### no-force

commit 때 data page flush를 강제하지 않고 log만 durable하게 한다. commit을 작은 순차 log I/O로 묶을 수 있지만 crash 뒤 committed 변경 중 data file에 없는 부분을 redo해야 한다.

| 정책 | 정상 경로 이득 | recovery 요구·비용 |
|---|---|---|
| steal | buffer 재사용, 큰 transaction 허용 | uncommitted page effect의 undo |
| no-steal | data file에 미완료 effect 없음 | memory 압력, frame 재사용 제약 |
| force | committed page가 즉시 data file에 있음 | commit의 다중 page flush |
| no-force | 빠른 commit·지연된 page flush | committed 변경 redo |

ARIES 계열 설명에서 흔한 steal/no-force는 redo와 undo를 모두 요구한다. 모든 현대 DBMS가 ARIES를 그대로 구현한다는 뜻은 아니다. MVCC·append-only·copy-on-write 엔진은 다른 recovery 구조를 선택할 수 있다.

## commit 경로와 group commit

단일 transaction의 commit 경로를 세분화한다.

```text
1. update log records가 log buffer에 있음
2. commit record append
3. WAL write: kernel/device 경로로 전달
4. WAL flush: 약속한 stable storage 경계 도달
5. transaction을 committed로 공개
6. client ACK
7. dirty data pages는 이후 flush 가능
```

4~6의 정확한 순서는 엔진과 동기 설정에 따라 다르며 replica acknowledgment는 06 파트에서 추가된다. 핵심은 write system call 반환만으로 power-loss durability를 가정하지 않는 것이다.

### group commit

동시에 commit을 기다리는 여러 transaction의 log를 한 번의 flush 경계로 묶을 수 있다.

```text
T1 commitLSN ─┐
T2 commitLSN ─┼─ one flush up to LSN X ─▶ T1,T2,T3 ACK
T3 commitLSN ─┘
```

flush 한 번의 고정 비용을 나눠 throughput을 높인다. 낮은 부하에서는 batch를 기다리는 시간이 latency에 더해질 수 있고 높은 부하에서는 device queue·log lock이 병목이 될 수 있다. commit 수, WAL bytes, flush 수, flush latency와 transactions per flush를 함께 본다.

commit을 지나치게 작게 나누면 매번 log flush와 transaction setup을 지불한다. 너무 크게 묶으면 lock·snapshot 유지, abort 비용과 log·undo 공간이 커진다. 적정 batch는 업무 원자성 단위를 보존하면서 측정한다.

## checkpoint는 snapshot 저장 버튼이 아니다

checkpoint의 핵심 목적은 recovery가 log 처음부터 모든 record를 재생하지 않도록 안전한 시작 정보와 log 재사용 경계를 전진시키는 것이다.

단순한 quiescent checkpoint는 새 transaction을 멈추고 모든 dirty page를 flush할 수 있지만 긴 pause가 생긴다. fuzzy checkpoint는 transaction과 page flush가 계속되는 동안 active transaction과 dirty page 정보를 기록한다. 따라서 checkpoint 완료 시점에도 dirty page가 존재할 수 있다.

```text
WAL: ── old ── checkpoint begin ── checkpoint end ── current LSN
                    │                    │
                    └─ active tx / dirty page metadata

recovery는 checkpoint 정보로 분석 범위를 줄이되
checkpoint 이후의 redo/undo 필요성을 판정한다.
```

checkpoint를 너무 드물게 하면 redo log 공간과 crash recovery 시간이 커진다. 너무 자주 또는 너무 급하게 dirty page를 밀어내면 background write spike와 foreground I/O 경쟁이 생긴다. 관찰 축은 다음과 같다.

- current/durable/checkpoint LSN 사이 거리
- dirty pages와 checkpoint write rate
- checkpoint duration과 I/O queue
- log space pressure로 강제 checkpoint 또는 write stall이 발생했는가
- 실제 restart에서 analysis·redo·undo 단계가 얼마나 걸리는가

## crash recovery의 세 질문

ARIES의 개념적 흐름은 analysis, redo, undo로 정리할 수 있다.

### analysis — crash 당시 상태를 재구성한다

checkpoint와 이후 log를 읽어 active transaction, committed/aborted 상태와 dirty page 후보를 찾는다. 어떤 transaction이 winner이고 loser인지, redo를 어디서 시작할지 정한다.

### redo — 필요한 변경을 반복해 history를 복원한다

committed 여부만 골라 적용하는 단순 설명과 달리 ARIES는 필요한 경우 미완료 transaction의 변경까지 포함해 crash 직전의 역사 repeating history를 수행한 뒤 undo한다. pageLSN 같은 조건으로 이미 반영된 record는 건너뛴다.

### undo — loser의 효과를 역순으로 제거한다

crash 시 commit하지 않은 transaction의 undo 가능 record를 뒤로 따라간다. compensation log record(CLR)는 수행한 undo를 다시 log해 recovery 중 또 crash해도 같은 undo를 무한 반복하지 않고 이어갈 수 있게 한다.

이 세 단계는 대표 모델이다. 특정 엔진의 startup phase, 병렬 recovery와 MVCC cleanup 명칭이 다를 수 있으므로 제품 지표를 ARIES 단계에 억지로 맞추지 않는다.

## crash point 실험

교육용 엔진에서 transaction T1이 page P의 값을 `5 → 1`로 바꾸고 T2는 `8 → 6`으로 바꾼다고 하자.

| crash point | durable log | data page | 사전 예측 |
|---|---|---|---|
| A: update log 전 | 없음 | old | 효과 없음 |
| B: T1 update log flush 후, page 전 | T1 update | old | T1 미commit이면 undo 대상 없거나 효과 없음, commit이면 아직 아님 |
| C: T1 page flush 후, commit 전 | T1 update | T1 new | steal이면 T1 uncommitted effect를 undo |
| D: T1 commit flush 후, page 전 | T1 update+commit | old | T1을 redo해 보존 |
| E: T1 page+commit 후, T2 미commit page 포함 | T1 committed, T2 update | both new | T1 유지, T2 undo |

각 crash point에서 실행 전에 다음을 기록한다.

1. durable해야 할 transaction 집합
2. redo 후보 LSN과 pageLSN 비교 결과
3. undo할 loser와 역순 record
4. recovery 중 다시 crash했을 때 재실행 가능 여부

복구 후 최종 값만 검사하지 않는다. committed transaction 보존, loser 제거, page checksum·B+트리 order 같은 구조 불변식과 두 번째 recovery의 멱등성을 자동 검증한다.

## WAL이 해결하지 못하는 장애

### process·OS crash와 media corruption은 다르다

WAL은 log와 data file 중 필요한 부분을 신뢰할 수 있다는 전제에서 crash consistency를 복원한다. 장치가 둘 다 잃거나 bit corruption, firmware 오류, 잘못된 `fsync` 계약, 운영자 삭제가 발생하면 local WAL만으로 복구하지 못할 수 있다.

- checksum은 손상을 감지할 수 있지만 원본을 자동 복원하지 않는다.
- replica는 잘못된 논리 변경이나 corruption을 복제할 수 있다.
- backup이 있어도 실제 restore와 log replay를 검증하지 않으면 복구 능력을 증명하지 못한다.

backup·restore 운영 절차는 이 챕터 범위 밖이지만 “WAL이 있으니 백업이 필요 없다”는 결론은 명백히 틀리다.

### torn page와 full-page 보호

page write 도중 crash가 나 일부 sector만 새 값이면 log의 변경 record를 적용할 기반 page 자체가 일관되지 않을 수 있다. 엔진은 full-page image, doublewrite buffer, atomic page/write 보장 또는 checksum과 replica 복구 등 다양한 전략을 쓴다. 어떤 전략이 있는지와 storage stack이 보장하는 atomic write 단위를 확인한다.

## 실무 관점

### commit latency를 data flush latency와 동일시하지 않는다

no-force 엔진에서 commit은 주로 WAL flush를 기다리고 data page는 뒤에 쓸 수 있다. 반대로 log device, group commit queue나 동기 replica가 지배할 수 있다. commit span을 WAL append/write/flush와 replica wait로 나눠 본다.

### 설정으로 `fsync`를 줄이면 성능 튜닝이 아니라 계약 변경이다

OS crash·전원 손실에서 최근 commit 유실을 허용할 수 있는 데이터인지 먼저 결정한다. benchmark에서만 빠른 설정을 운영에 옮기거나, replica가 있으니 local durability를 완전히 대체한다고 가정하지 않는다.

### recovery 시간은 실제 restart로 검증한다

WAL byte 수만으로 복구 시간을 단정할 수 없다. dirty page 분포, storage throughput, parallelism, 긴 loser transaction의 undo와 cache cold start가 영향을 준다. 격리된 환경에서 crash injection과 restart를 수행하고 서비스 가능 시점과 background rollback 완료 시점을 구분한다.

## 정리

- WAL은 data page보다 관련 log가 먼저 durable해야 한다는 순서 계약이다.
- steal은 undo를, no-force는 redo를 요구하며 정상 경로의 buffer·commit 비용과 교환한다.
- 내구성 있는 성공 응답은 commit record의 durable flush 경계와 연결해야 한다.
- group commit은 여러 transaction이 한 flush 비용을 나누지만 batch 대기와 log contention 경계를 가진다.
- fuzzy checkpoint 뒤에도 dirty page와 active transaction이 있을 수 있으며 checkpoint는 recovery 범위와 log 재사용을 관리한다.
- crash recovery와 media corruption 복구는 다른 문제이며 local WAL은 backup·검증된 restore를 대체하지 않는다.

## 확인 문제

1. `pageLSN=900`인 dirty page를 `durableLSN=850`일 때 data file에 썼다. crash 시 어떤 복구 정보가 사라질 수 있는가?
2. commit record는 durable하지만 해당 data page는 old version인 채 crash했다. no-force 정책에서 정상적으로 복구할 수 있는 이유는 무엇인가?
3. checkpoint가 방금 끝났는데 dirty page가 남아 있다. 이것이 반드시 오류가 아닌 이유는 무엇인가?
4. WAL flush 설정을 완화해 commit p99가 줄었다. 성능 개선이라고 결론 내리기 전에 명시할 계약은 무엇인가?

<details>
<summary>정답과 해설</summary>

1. page에는 LSN 900까지의 변경이 있지만 log는 850까지만 남는다. 미완료 transaction의 변경을 식별·undo하거나 torn/incomplete state를 복원할 record가 없어 WAL 선행 기록 불변식을 위반한다.
2. durable WAL에 update와 commit record가 있으므로 recovery가 pageLSN을 비교해 빠진 committed 변경을 redo할 수 있다. 이것이 commit 때 모든 data page를 force하지 않아도 되는 근거다.
3. fuzzy checkpoint는 transaction을 멈추고 모든 page를 동기 flush하는 저장점이 아니다. active transaction·dirty page 정보를 기록해 recovery 시작 범위를 정하고 page flush는 계속 진행할 수 있다.
4. process crash, OS crash, 전원 손실 각각에서 ACK한 transaction이 어디까지 보존되는지와 허용 가능한 손실 구간을 명시한다. replica acknowledgment가 있다면 그 durable/apply 조건도 별도로 확인한다.

</details>

## 참고 자료

- [ARIES: A Transaction Recovery Method](https://research.ibm.com/publications/aries-a-transaction-recovery-method-supporting-fine-granularity-locking-and-partial-rollbacks-using-write-ahead-logging): WAL, repeating history, compensation log record와 fine-grained locking을 결합한 원 논문이다.
- [PostgreSQL: Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html): data file보다 WAL을 먼저 flush하는 원리와 checkpoint를 설명하는 공식 문서다.
- [PostgreSQL: WAL Configuration](https://www.postgresql.org/docs/current/wal-configuration.html): checkpoint 거리·쓰기와 recovery 시간 사이의 제품별 tradeoff를 확인한다.
- [MySQL 8.4: InnoDB Redo Log](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html): LSN, append와 checkpoint에 따른 redo log 재사용을 설명한다.
- [MySQL 8.4: InnoDB Recovery](https://dev.mysql.com/doc/refman/8.4/en/innodb-recovery.html): redo 적용, 미완료 transaction rollback과 media failure의 backup 경계를 구분한다.
- [SQLite: Atomic Commit](https://www.sqlite.org/atomiccommit.html): OS·device flush와 rollback journal을 이용해 atomic commit을 구성하는 다른 recovery 설계를 단계별로 보여 준다.
