# 챕터 9 실습 — 패킷 캡처 기반 요청 지연 분석

[ROADMAP](../../ROADMAP.md) 챕터 9의 산출물인 **클라이언트–프록시–원 서버 경로의 지연을 계층별 증거로 진단하는 리포트**를 작성한다. [챕터 9 기획](../../plan/ch-9.md)과 본문 5편의 동작 모델을 전제로 한다.

## 학습 목표

- DNS, TCP/TLS, TTFB, 본문 전송 시간을 패킷과 애플리케이션 timing에 대응시킨다.
- RTT·손실·캐시·연결 재사용 중 한 변수만 바꾼 대조 실험을 설계한다.
- HTTP/1.1과 HTTP/2의 연결 사용 및 다중화 차이를 관찰한다.
- 클라이언트, reverse proxy, origin의 지표를 합쳐 병목 구간과 완화책의 비용을 설명한다.

## 기준 환경과 안전

Linux가 기준이다. 별도 VM이나 실습 전용 호스트를 권장하며, `tc`와 network namespace를 쓰려면 root 또는 `CAP_NET_ADMIN`이 필요하다. 브라우저 DevTools 실험은 호스트에서 수행할 수 있다.

필수 도구는 `curl`, `dig`, `ip`, `ss`, `tcpdump` 또는 Wireshark다. HTTP/2를 지원하는 reverse proxy와 간단한 origin 서버를 자유롭게 선택하되 제품별 기능이 아니라 관찰할 계약을 기준으로 설정한다.

운영 트래픽을 무단 캡처하지 않는다. 실습용 인증서의 비밀 키, 세션 키 로그, 패킷 캡처에는 민감 정보가 들어갈 수 있으므로 저장소에 커밋하지 않는다.

## 토폴로지

```text
client namespace ──(구간 A)── reverse proxy ──(구간 B)── origin
       │                    │                         │
 curl/DevTools          access log              server timing
 tcpdump A              cache/upstream log      tcpdump B
```

DNS 이름은 `/etc/hosts`로 고정하지 말고 실습 DNS 또는 `curl --resolve`를 사용해 DNS 기준선과 주소 고정 대조군을 구분한다. namespace를 사용하지 못하면 loopback의 서로 다른 포트로 축소할 수 있지만 RTT·MTU 실험의 한계를 리포트에 적는다.

## Part A — 기준선과 증거 대응

1. `curl` timing을 최소 20회 수집한다. 다음 템플릿을 파일로 저장해 사용한다.

```text
dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} remote=%{remote_ip} version=%{http_version}\n
```

```sh
curl -sS -o /dev/null -w @timing.txt https://api.example.test/data
```

2. 같은 요청을 `tcpdump -i any -nn -s0 -w baseline.pcap`으로 캡처한다.
3. DNS 질의·응답, SYN/SYN-ACK/ACK, TLS handshake, 첫 HTTP 응답 데이터의 패킷 번호와 시간을 표로 대응시킨다.
4. 첫 연결과 재사용 연결을 분리한다. 한 프로세스에서 여러 URL을 요청하거나 브라우저 waterfall을 사용해 연결 재사용 여부를 확인한다.

## Part B — 네트워크 조건과 HTTP 버전

`tc netem`은 한 번에 한 변수만 바꾼다. 적용 인터페이스는 토폴로지에 맞게 바꾸고 종료 시 qdisc를 삭제한다.

```sh
tc qdisc add dev veth-client root netem delay 50ms
tc qdisc replace dev veth-client root netem loss 1%
tc qdisc del dev veth-client root
```

다음 조건에서 각 20회 이상 측정하고 p50·p95를 비교한다.

| 실험 | 독립 변수 | 관찰 |
|---|---|---|
| RTT | 0ms / 50ms / 100ms | handshake와 TTFB 증가량, 연결 재사용 효과 |
| 손실 | 0% / 0.5% / 1% | 재전송, RTT/RTO, 처리량과 p95 |
| HTTP | `curl --http1.1` / `--http2` | 연결 수, 동시 stream, waterfall |
| 객체 수 | 큰 객체 1개 / 작은 객체 여러 개 | 다중화와 HOL의 영향 |

`ss -ti dst <server-ip>`와 Wireshark의 TCP 분석 필드로 RTT, retransmission, congestion window 관련 증거를 보강한다. 오프로딩 때문에 로컬 캡처의 세그먼트 크기나 checksum이 비정상으로 보일 수 있으므로 캡처 위치와 NIC offload 여부를 기록한다.

## Part C — 프록시 경로 분해

다음 조건을 각각 비교한다.

1. cache miss와 cache hit: proxy와 origin 양쪽 로그로 origin 요청 유무를 확인한다.
2. upstream keep-alive on/off: 구간 B에서 SYN과 TLS handshake 수가 달라지는지 확인한다.
3. origin 지연 0ms/200ms: 클라이언트 TTFB와 proxy upstream timing이 같은 폭으로 변하는지 확인한다.

프록시 로그에는 전체 요청 시간, upstream connect time, upstream header/response time, cache status, trace ID를 남긴다. 필드 이름은 제품마다 달라도 네 의미가 분리되어야 한다. `Forwarded`나 `X-Forwarded-For`를 사용할 때는 신뢰하는 프록시가 기존 값을 제거·재작성하는 설정과 그 이유를 기록한다.

## Part D — 장애 진단

동료가 다음 중 하나를 선택해 원인을 숨기거나, 스스로 임의 순서로 적용한다.

- DNS 응답 지연 또는 잘못된 주소
- 작은 MTU와 차단된 ICMP로 인한 PMTUD 실패
- 구간 A 또는 B의 패킷 손실
- origin 처리 지연

진단자는 먼저 경쟁 가설을 두 개 이상 적고, 가장 적은 비용의 증거부터 수집한다. 해결책을 적용한 뒤 같은 측정으로 회복을 확인한다. 타임아웃 뒤 요청이 실제로 처리되었는지는 네트워크 성공 여부와 별도의 애플리케이션 증거로 확인한다.

## 선택 심화 — QUIC과 HTTP/3

HTTP/3를 지원하는 로컬 서버와 `curl --http3` 환경이 있으면 TCP+TLS와 QUIC의 초기 연결, 재개 연결, 단일 손실 시 여러 stream의 진행을 비교한다. UDP 차단 시 HTTP/2로 대체되는지도 관찰한다. 로컬 환경 구축과 TLS 키 로그 복호화가 필요하므로 필수 완료 기준에는 포함하지 않는다.

## 리포트 요구사항

1. 토폴로지, OS·커널, 도구·서버 버전, 인증서와 DNS 구성, qdisc 설정을 기록한다.
2. 결과를 보기 전에 각 실험의 예측과 반증 조건을 쓴다.
3. 반복 측정의 p50·p95와 원자료를 제시하고 단일 측정을 대표값으로 사용하지 않는다.
4. 애플리케이션 timing, 소켓 상태, 패킷 번호를 같은 타임라인에 대응시킨다.
5. 병목 완화책이 지연·처리량·자원·보안에 주는 이득과 비용을 함께 쓴다.

## 완료 기준

- [ ] 기준선 요청의 DNS, TCP/TLS, TTFB, transfer 구간을 패킷과 대응했다.
- [ ] RTT와 손실 실험에서 한 변수씩 통제하고 HTTP/1.1·2 결과를 비교했다.
- [ ] cache hit/miss와 upstream 연결 재사용 여부를 proxy·origin 증거로 구분했다.
- [ ] 숨겨진 장애를 경쟁 가설과 최소 증거로 진단하고 동일 절차로 회복을 확인했다.
- [ ] 환경·재현 명령·반복 측정 분포·측정 한계·완화책의 비용을 리포트에 포함했다.
