# 9.2 신뢰 가능한 전송의 비용 — TCP, UDP와 혼잡 제어

> TCP는 손실 없는 네트워크를 가정하지 않는다. 순서·재전송·흐름·혼잡 상태를 관리해 신뢰 가능한 byte stream이라는 추상화를 만든다.

## 학습 목표

- sequence number와 ACK로 TCP의 순서 보장과 재전송을 설명한다.
- receive window와 congestion window가 해결하는 문제를 구분한다.
- RTT, bandwidth-delay product, 손실이 처리량과 꼬리 지연에 미치는 영향을 진단한다.
- UDP의 datagram 계약과 애플리케이션이 떠안는 책임을 판단한다.

## 배경: IP가 하지 않는 일

IP는 packet을 목적지로 전달하려 시도하지만 도착, 중복 제거, 순서, 대역폭 공정성을 보장하지 않는다. TCP는 이 불완전한 서비스 위에 애플리케이션이 읽고 쓰는 양방향 byte stream을 제공한다. 추상화의 가격은 연결별 상태, handshake, ACK, buffer, timer, 혼잡 제어다.

## 연결은 양 끝의 상태 합의다

TCP 연결은 흔히 source/destination address와 port의 네 값으로 식별한다. active opener가 SYN과 initial sequence number를 보내고, 상대가 SYN+ACK로 자기 sequence와 상대 SYN을 확인한 뒤 ACK가 돌아가면 양쪽은 byte stream의 출발점을 합의한다.

```text
client                                server
  SYN seq=x ---------------------------->
           <---------------- SYN seq=y, ACK=x+1
  ACK=y+1 ------------------------------>
```

3-way handshake는 단순한 생존 확인이 아니다. 양방향 sequence 공간을 동기화하고 과거에 지연된 segment를 새 연결의 데이터로 오인하지 않게 한다. 첫 애플리케이션 데이터 전 최소 1 RTT가 드는 이유다.

종료는 각 방향이 독립적이다. FIN은 “이 방향에서 더 보낼 byte가 없다”는 뜻이고 peer도 별도로 FIN을 보낸다. active closer가 TIME_WAIT에 머무는 것은 지연된 과거 segment가 같은 tuple의 새 연결에 섞이는 것을 막고 마지막 ACK가 유실됐을 때 다시 응답하기 위해서다. TIME_WAIT가 많다는 사실만으로 leak이라 결론 내리지 않는다. 연결 생성률, ephemeral port 범위, 재사용 정책을 함께 본다.

## byte stream — 메시지 경계는 없다

애플리케이션이 `write()`를 두 번 호출해도 수신 측 `read()`가 두 번 같은 크기로 반환된다는 보장은 없다. TCP는 byte 순서만 보장하고 segment와 애플리케이션 메시지의 경계를 보존하지 않는다.

```text
sender write("ABC"), write("DEF")
receiver may read "A" + "BCDEF", or "ABCDEF", or other ordered splits
```

따라서 상위 프로토콜은 길이 prefix, delimiter, 고정 길이, self-delimiting encoding 중 하나로 framing해야 한다. “한 번 read하면 요청 하나”인 코드는 로컬 테스트에서는 우연히 동작해도 지연·buffer 조건이 바뀌면 깨진다.

## sequence와 ACK — 누락을 찾는 좌표계

TCP sequence number는 segment 번호가 아니라 byte의 좌표다. ACK `N`은 일반적으로 “N 이전 byte까지 연속으로 받았고 다음에는 N을 기대한다”는 누적 확인이다. 중간 segment가 빠지고 뒤 segment가 도착하면 receiver는 같은 ACK를 반복하거나 SACK option으로 받은 범위를 알린다.

송신자는 두 신호로 손실을 추론한다.

- **timer 만료**: 추정 RTT에서 계산한 retransmission timeout(RTO)까지 ACK가 오지 않는다. 확실하지만 오래 기다린다.
- **중복 ACK/SACK**: 뒤 데이터가 왔는데 앞 구간이 비었다. timer 전 fast retransmit으로 복구할 수 있다.

모든 재전송이 네트워크 손실을 뜻하지는 않는다. 캡처 위치가 sender와 receiver 사이 어디인지, NIC offload와 capture loss가 있는지 확인한다. Wireshark의 “TCP Retransmission” 표시는 패킷 관찰에서 유도한 분석 결과이지 양 끝 kernel의 최종 판단 자체가 아니다.

## RTT와 RTO — 평균보다 변동이 중요하다

Round-trip time(RTT)은 packet과 그 응답이 왕복하는 시간이다. TCP는 관측 RTT를 평활하고 변동을 반영해 RTO를 정한다. 고정된 평균 RTT가 같아도 jitter가 크면 너무 공격적인 timeout은 정상 지연을 손실로 오인하고 불필요한 재전송을 만든다.

```sh
ss -ti dst 203.0.113.10
```

Linux의 출력에서 `rtt`, `rto`, `retrans`, `cwnd` 등을 관찰할 수 있다. 필드는 kernel 버전과 congestion control에 따라 달라지며 한 snapshot보다 부하 전후 변화를 본다.

## 두 window — 수신자와 네트워크를 각각 보호한다

송신자가 ACK 없이 보낼 수 있는 양은 대략 다음 두 제한 중 작은 값이다.

```text
in-flight ≤ min(rwnd, cwnd)
```

- **receive window(rwnd)**는 receiver buffer 여유를 광고한다. 빠른 sender가 느린 애플리케이션의 memory를 덮어버리지 않게 하는 흐름 제어(flow control)다.
- **congestion window(cwnd)**는 네트워크가 감당할 것으로 추정한 in-flight 상한이다. 중간 router queue와 다른 flow를 보호하는 혼잡 제어(congestion control)다.

`rwnd`가 작으면 receiver/application 병목이고 `cwnd`가 작으면 경로의 용량 탐색·손실 반응이 병목일 가능성이 크다. 둘을 “TCP window” 하나로 부르면 처방이 뒤집힌다.

## slow start와 AIMD — 모르는 경로를 탐색하기

새 연결은 경로 용량을 모른다. 전통적인 설명에서 slow start는 ACK가 돌아오는 동안 cwnd를 빠르게 늘려 사용 가능한 용량을 탐색한다. 임계값 이후 congestion avoidance는 더 완만하게 늘리고, 손실 같은 congestion signal에 window를 줄인다. 증가에는 신중하고 혼잡에는 물러나는 additive increase/multiplicative decrease(AIMD)가 여러 flow의 공유를 가능하게 한다.

실제 Linux는 Cubic이나 BBR 같은 알고리즘을 사용할 수 있고 세부 window 변화는 Reno식 도식과 다르다. 그래도 다음 공통 모델은 유지된다.

1. sender는 무제한으로 보내지 않고 in-flight budget을 관리한다.
2. ACK는 전달 진전과 RTT의 신호다.
3. 손실·ECN·시간 정보로 경로 혼잡을 추정하고 전송률을 조정한다.

연결을 자주 새로 만들면 handshake뿐 아니라 학습한 경로 상태를 버리고 다시 탐색하는 비용도 낸다. keep-alive와 connection pool이 중요한 이유다.

## bandwidth-delay product — 채워야 할 파이프의 크기

대역폭이 `B`, RTT가 `R`인 경로를 가득 활용하려면 대략 `B × R`만큼의 데이터가 비행 중이어야 한다.

예를 들어 100 Mbit/s, RTT 100ms면 BDP는 약 10 Mbit, 즉 1.25 MB다. window가 64 KiB라면 link 대역폭이 남아도 한 RTT마다 64 KiB만 전진해 처리량이 제한된다. 대역폭 증설이 처리량을 올리지 못할 때 RTT와 window를 함께 보는 이유다.

반대로 buffer를 무조건 크게 만들면 queue가 packet을 버리지 않고 오래 쌓아 throughput은 유지해도 latency가 폭증하는 **bufferbloat**가 생긴다. 목표는 손실 0이 아니라, 짧은 queue와 충분한 utilization 사이의 균형이다.

## 손실이 꼬리 지연을 키우는 방식

낮은 평균 손실률도 객체가 크거나 요청 수가 많으면 적어도 한 번 손실을 만날 확률을 키운다. 복구는 RTT 단위로 일어나므로 p50보다 p95·p99가 크게 악화될 수 있다. 작은 API 응답은 handshake의 RTT가 지배하고, 큰 전송은 cwnd·rwnd·손실·대역폭이 지배한다. 같은 “네트워크 최적화”를 두 workload에 적용해서는 안 된다.

관찰 실험:

```sh
# 실습 전용 interface에서만 실행한다.
sudo tc qdisc add dev veth-client root netem delay 50ms
sudo tc qdisc replace dev veth-client root netem loss 1%
sudo tc qdisc del dev veth-client root
```

`tc netem`은 지연·손실·재정렬·속도 제한을 흉내 낼 수 있다. 한 번에 한 변수만 바꾸고 반복 측정한다. loopback에 적용하면 관리 연결까지 끊을 수 있으므로 namespace의 veth 같은 격리된 interface를 사용한다.

## UDP — 적은 계약, 넓은 설계 공간

UDP는 datagram의 메시지 경계를 보존하고 checksum으로 손상을 탐지하지만 전달, 순서, 중복 제거, 재전송, congestion control, 연결 상태를 제공하지 않는다. “빠른 TCP”가 아니라 **애플리케이션이 필요한 보장만 구성할 수 있는 최소 전송 계약**이다.

실시간 음성은 늦게 도착한 과거 packet을 재전송하느라 현재 음성을 막는 것보다 일부 누락을 conceal하는 편이 낫다. 반대로 DNS처럼 짧은 request/response는 timeout과 retry를 애플리케이션이 관리할 수 있다. QUIC은 UDP 위에서 encryption, stream, loss recovery, congestion control을 다시 구성해 kernel TCP의 고정된 wire behavior와 배포 주기에서 벗어난다.

UDP를 쓴다고 congestion 책임이 사라지지는 않는다. 대량 UDP sender가 feedback 없이 전송하면 다른 flow와 router queue를 압도한다. QUIC도 TCP와 유사한 congestion control 원칙을 의무적으로 갖는 이유다.

## 실무 관점

### timeout은 계층별로 예산을 나눈다

connect timeout, TLS timeout, response-header timeout, idle/read timeout은 서로 다른 상태를 제한한다. 하나의 30초 global timeout만 두면 어느 단계가 예산을 소비했는지 알 수 없고 장애 감지가 늦다. 반대로 지나치게 짧은 timeout은 정상 RTT 변동을 실패로 바꾸어 retry storm을 만든다.

### keepalive는 두 종류다

HTTP keep-alive/connection reuse는 여러 HTTP request가 같은 transport connection을 쓰는 정책이다. TCP keepalive는 오랫동안 데이터가 없을 때 probe로 죽은 peer나 중간 상태 만료를 탐지하는 기능이다. 이름이 비슷하지만 목적과 시간 규모가 다르다.

### “연결됨”은 업무 성공이 아니다

TCP handshake 성공은 양 끝 transport가 상태를 만들었다는 뜻이다. ACK는 byte 수신이고 FIN은 byte stream 종료다. 애플리케이션의 parsing, authorization, transaction commit은 모두 그 위의 별도 계약이다. 타임아웃 요청을 재시도할 때 중복 실행을 막는 설계는 후속 챕터 10에서 다룬다.

## 정리

- TCP는 연결별 sequence, ACK, timer와 buffer로 신뢰 가능한 ordered byte stream을 만든다.
- 흐름 제어의 rwnd는 receiver를, 혼잡 제어의 cwnd는 network를 보호한다.
- 처리량은 bandwidth뿐 아니라 RTT, BDP, window, loss의 함수다.
- UDP는 메시지 경계를 보존하지만 신뢰성·혼잡 제어를 애플리케이션에 맡긴다.
- 패킷 분석 표시는 가설의 증거이며 캡처 위치와 offload 영향을 함께 검토한다.

## 확인 문제

1. 1 Gbit/s 회선으로 바꿨는데 장거리 단일 TCP 전송이 빨라지지 않았다. 다음으로 확인할 변수와 이유는 무엇인가?
2. `rwnd`는 충분한데 `cwnd`가 작고 재전송이 늘었다. receiver buffer 확대가 해결책이 아닌 이유는 무엇인가?
3. TCP 서버가 `read()` 한 번에 요청 하나가 온다고 가정한다. 어떤 조건에서 깨지며 어떻게 고쳐야 하는가?

<details>
<summary>정답과 해설</summary>

1. RTT, 실제 in-flight/window, 손실을 확인한다. window가 BDP보다 작거나 손실 때문에 cwnd가 반복 감소하면 남은 bandwidth를 채우지 못한다.
2. rwnd가 수신 능력의 병목이 아니고 cwnd는 경로 congestion 추정에 의해 제한된다. 손실 위치와 queue, congestion control을 조사해야 한다.
3. TCP는 write/read 경계를 보존하지 않아 어떤 네트워크에서도 분할·병합될 수 있다. 길이 prefix나 delimiter 등 상위 framing과 부분 read loop를 구현한다.

</details>

## 참고 자료

- [RFC 9293 — Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc9293.html): 현대 TCP의 기본 기능과 상태·sequence·window 요구사항이다.
- [RFC 5681 — TCP Congestion Control](https://www.rfc-editor.org/rfc/rfc5681.html): slow start, congestion avoidance, fast retransmit/recovery의 기준이다.
- [RFC 6298 — Computing TCP's Retransmission Timer](https://www.rfc-editor.org/rfc/rfc6298.html): RTT 측정에서 RTO를 계산하는 규칙이다.
- [RFC 8085 — UDP Usage Guidelines](https://www.rfc-editor.org/rfc/rfc8085.html): UDP 애플리케이션의 congestion·message size·reliability 책임을 설명한다.
- [tc-netem(8)](https://man7.org/linux/man-pages/man8/tc-netem.8.html): Linux에서 지연·손실 조건을 주입하는 공식 매뉴얼이다.
