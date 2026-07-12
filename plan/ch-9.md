# 챕터 9 기획 — 네트워크

[ROADMAP.md](../ROADMAP.md)의 챕터 9(`docs/ch-9/`, 인트로 1편과 본문 5편)을 집필하기 위한 상세 기획이다. 범위·경로가 ROADMAP과 어긋나면 ROADMAP을 우선한다.

## 1. 챕터의 관점

독자는 DNS, HTTP, TLS를 매일 사용하고 타임아웃과 502를 운영에서 보아 왔지만, `request_time=3s`라는 한 숫자를 어느 네트워크 상태가 만들었는지 설명하지 못할 수 있다. 이 챕터는 프로토콜 필드 목록이 아니라 **한 원격 요청의 지연을 계층·구간별 증거로 분해하는 모델**을 세운다.

공통 사례는 브라우저나 `curl`이 `https://api.example.test/orders`를 호출하는 요청이다. 모든 문서는 다음 진단 루프를 공유한다.

1. 이름 해석, 연결, TLS, 첫 바이트, 본문 전송으로 시간을 분해한다.
2. 각 구간의 경쟁 가설을 세우고 애플리케이션 timing, 소켓 상태, 패킷 중 가장 싼 증거를 고른다.
3. RTT·손실·큐·캐시·연결 재사용을 한 변수씩 바꿔 가설을 반증한다.
4. 개선이 지연, 처리량, 자원, 보안 중 무엇을 얻고 포기하는지 기록한다.

기준 환경은 Linux와 브라우저다. Linux 전용 도구와 프로토콜 표준을 구분하고, 절대 성능 수치보다 통제된 조건에서의 상대 변화와 원인 설명을 우선한다.

## 2. 범위와 위임

### 다루는 것

- DNS의 재귀 해석·위임·캐시·TTL·negative caching과 해석 지연
- IPv4 주소·CIDR, longest prefix match, default gateway, NAT 상태, IPv6 이중 스택과 Happy Eyeballs
- MTU와 PMTUD, 비대칭 경로, `traceroute`가 보여 주는 것과 숨기는 것
- TCP 연결·종료, sequence/ACK·재전송·RTT/RTO, 수신 윈도우와 혼잡 윈도우, slow start와 손실 복구
- UDP의 datagram 계약과 애플리케이션 책임
- HTTP 의미론의 최소 계약, HTTP/1.1 연결 재사용, HTTP/2 frame·stream·HPACK·flow control
- TLS 1.3의 연결 비용, SNI·ALPN, 세션 재개와 0-RTT 경계
- QUIC의 패킷·스트림·연결 ID·연결 이동과 HTTP/3
- reverse proxy, L4/L7 로드 밸런서, CDN 캐시, TLS 종단, upstream pool, timeout budget, 전달 헤더와 trace context

### 위임하는 것

| 주제 | 위임 대상 | 챕터 9에서의 취급 |
|---|---|---|
| 암호 프리미티브와 인증서 신뢰 사슬 | ch-3 `02-cryptography.md` | TLS 핸드셰이크의 네트워크 비용과 실패 지점만 담당 |
| epoll과 이벤트 루프 | ch-8 `03-file-systems-and-io.md` | 소켓이 readiness를 만드는 이유를 링크로 재사용 |
| 부분 실패, 재시도, 멱등성 | ch-10 | 타임아웃이 미실행을 뜻하지 않는다는 경계만 담당 |
| 컨테이너 namespace와 cgroup | ch-12 | 실습 토폴로지의 격리 수단으로 사용하되 원리는 위임 |

### 다루지 않는 것

- Ethernet, VLAN, STP, 무선 링크는 첫 홉과 MTU를 이해하는 최소 수준만 다룬다.
- BGP 정책과 라우터 구현, DNSSEC·DoH/DoT의 상세 운용, VPN은 독립 주제로 확장하지 않는다.
- 특정 클라우드·CDN·서비스 메시 제품의 설정법과 비교는 다루지 않는다.
- 최신 혼잡 제어 알고리즘을 카탈로그화하지 않는다. 공통 불변식과 Linux에서 관찰 가능한 상태에 집중한다.

## 3. 문서별 설계

- `00-introduction.md`: `curl -w`와 DevTools timing으로 한 요청을 DNS, connect, TLS, TTFB, transfer로 나눈다. 세 관찰 층(애플리케이션·소켓·패킷)과 챕터 지도를 세운다.
- `01-internet-path-and-dns.md`: 이름이 주소가 되고 주소가 다음 홉으로 바뀌는 과정을 다룬다. `dig`, `ip route get`, `tracepath`로 캐시·라우팅·MTU 가설을 구분한다.
- `02-transport-reliability-and-congestion.md`: 불완전한 IP 위에서 TCP가 신뢰성과 공정성을 만드는 비용을 다룬다. `ss -ti`, `tcpdump`, `tc netem`으로 RTT·재전송·윈도우를 관찰한다.
- `03-http-evolution.md`: HTTP/1.1과 HTTP/2가 메시지를 연결에 배치하는 방식과 HOL의 계층 이동을 다룬다. DevTools waterfall과 `curl`로 연결 재사용·다중화를 비교한다.
- `04-tls-quic-and-http3.md`: TLS 1.3과 QUIC이 보안·전송 핸드셰이크를 조립하는 방식, 0-RTT와 연결 이동의 경계를 다룬다.
- `05-proxies-load-balancers-and-cdns.md`: 하나로 보이는 요청이 여러 연결과 TLS 종단으로 잘리는 프로덕션 경로를 다룬다. 클라이언트·프록시·원 서버의 timing과 trace를 합쳐 병목을 찾는다.

## 4. 통합 실습

[exercises/ch-9/README.md](../exercises/ch-9/README.md)의 산출물은 패킷 캡처 기반 요청 지연 분석 리포트다. 클라이언트–reverse proxy–origin을 구성하고 다음을 수행한다.

1. DNS, TCP/TLS, TTFB, transfer 기준선을 애플리케이션 timing과 패킷으로 대응시킨다.
2. `tc netem`으로 RTT와 손실을 각각 바꾸고 재전송·처리량·꼬리 지연 변화를 설명한다.
3. HTTP/1.1과 2, proxy cache hit/miss, upstream keep-alive on/off를 비교한다.
4. DNS 지연·MTU 문제·손실·느린 origin 중 하나의 장애를 경쟁 가설과 최소 증거로 진단한다.

HTTP/1.1·2는 필수다. HTTP/3은 로컬 서버 지원과 패킷 복호화 준비 비용이 크므로 심화 트랙이다.

## 5. 작성·검증 기준

- 프로토콜 규범은 RFC Editor의 현재 RFC를 기준으로 하고 구현·도구 동작은 공식 문서와 실제 실행으로 확인한다.
- 패킷 캡처는 민감한 운영 트래픽 대신 로컬 실험 환경에서 수행하며 캡처 파일을 저장소에 커밋하지 않는다.
- 성능 주장은 반복 측정 분포와 환경 정보를 동반한다. 단일 waterfall이나 한 번의 `ping`을 결론으로 사용하지 않는다.
- 각 확인 문제는 용어 회상이 아니라 주어진 timing·패킷·소켓 상태에서 다음 가설과 실험을 고르게 한다.
- `pnpm docs:build`, 내비게이션 문서 수·순서, 내부 링크, `git diff --check`를 완료 조건으로 삼는다.

## 6. 1차 자료

- RFC 1034/1035(DNS), RFC 2308(negative caching), RFC 8305(Happy Eyeballs v2)
- RFC 8200(IPv6), RFC 8201(IPv6 PMTUD), RFC 9293(TCP), RFC 5681(TCP congestion control)
- RFC 8446(TLS 1.3), RFC 9000/9001/9002(QUIC), RFC 9110/9111/9112/9113/9114(HTTP)
- Linux `ip-route(8)`, `ss(8)`, `tc-netem(8)`, Wireshark User's Guide, curl 공식 문서
