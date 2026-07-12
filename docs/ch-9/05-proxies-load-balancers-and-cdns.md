# 9.5 프로덕션 요청 경로 — 프록시, 로드 밸런서와 CDN

> 하나의 HTTPS 요청처럼 보여도 프로덕션에서는 여러 DNS 결정, 연결, TLS 종단, 큐와 캐시로 분절된다. 병목은 구간별로 측정해야 한다.

## 학습 목표

- forward/reverse proxy와 L4/L7 load balancer가 요청 경로에 추가하는 상태와 비용을 설명한다.
- health check와 분산 알고리즘을 workload와 failure mode에 맞춰 선택한다.
- CDN cache key·freshness·revalidation이 origin 부하와 정확성에 미치는 영향을 판단한다.
- client·edge·origin timing과 trace context를 합쳐 병목 구간을 진단한다.

## 배경: end-to-end 연결은 어디서 끝나는가

사용자는 `https://api.example.com` 한 URL을 호출하지만 실제 경로는 다음과 같을 수 있다.

```text
client
  ║ QUIC/TLS A
CDN edge
  ║ TCP/TLS B
regional load balancer
  ║ TCP/TLS C
reverse proxy / sidecar
  ║ TCP D
application
```

각 `║`는 독립된 RTT, handshake, connection pool, congestion state, timeout을 가진다. edge가 client에 `200`을 보낼 때 origin 연결은 이미 끝났을 수도 있고 cache hit이면 origin에 요청 자체가 없을 수 있다. client packet capture만으로 구간 B~D의 손실을 볼 수 없는 이유다.

## proxy — 연결을 받아 새 연결로 전달한다

forward proxy는 client를 대신해 외부로 나가고, reverse proxy는 server 앞에서 client 요청을 받는다. 둘 다 application 관점에서는 intermediary이지만 정책 주체와 신뢰 방향이 다르다.

reverse proxy는 흔히 다음 책임을 조합한다.

- TLS termination과 certificate 관리
- HTTP parsing, routing, authentication·rate limit
- request/response buffering과 압축
- upstream connection pooling, retry, timeout
- cache와 observability header 삽입

기능마다 비용이 있다. TLS termination은 application을 단순화하지만 proxy가 plaintext와 private key를 다루는 신뢰 경계가 된다. buffering은 느린 client로부터 upstream을 보호하지만 streaming TTFB와 memory를 희생한다. retry는 일시 실패를 가리지만 duplicate side effect와 retry amplification을 만든다.

### 연결 재사용은 양쪽에서 독립적이다

client가 edge 연결을 재사용해도 edge가 매번 origin 연결을 새로 만들 수 있다. 반대로 여러 client request를 작은 upstream pool에 다중화할 수 있다. 따라서 client의 `num_connects=0`만 보고 origin handshake 비용이 없다고 결론 내릴 수 없다.

proxy 로그는 최소한 다음 구간을 분리해야 한다.

```text
total request time
├── request queue / proxy processing
├── upstream connect time
├── upstream first-header time
└── downstream body transfer time
```

제품별 필드 이름은 달라도 경계는 같다. 전체 시간만 기록하면 proxy를 추가한 순간 진단 가능성이 오히려 나빠진다.

## L4와 L7 load balancer

### L4 — transport 정보를 보고 flow를 전달한다

L4 load balancer는 주로 address, port, protocol과 connection 상태를 기준으로 backend를 고른다. payload를 해석하지 않아 overhead와 protocol coupling이 작고 TCP 외 protocol도 다루기 쉽다. 그러나 URL, header, cookie 기반 routing이나 HTTP response별 관찰은 할 수 없다.

NAT 방식, direct server return, proxy 방식에 따라 return path와 source IP 보존이 달라진다. packet capture 위치를 정할 때 이 data path를 알아야 한다.

### L7 — HTTP 의미를 보고 요청을 전달한다

L7 load balancer는 TLS를 종단하거나 복호화된 HTTP를 받아 host, path, header, method로 routing한다. request 단위 retry, canary, authentication, cache가 가능하지만 parsing·buffer·CPU와 더 넓은 공격 표면을 지불한다. client와 LB, LB와 backend는 별도 connection이므로 transport 문제가 독립적이다.

“L7이 더 똑똑하니 항상 낫다”가 아니다. 필요한 policy가 transport tuple만으로 충분하면 L4의 작은 coupling과 비용이 장점이다.

## health check — 트래픽을 받을 수 있다는 증거

health check는 backend가 요청을 받을 후보인지 판단한다.

- TCP connect check는 process가 port를 listen하는지만 확인한다.
- HTTP shallow check는 server loop와 routing까지 확인한다.
- deep check가 DB와 모든 dependency를 검사하면 실제 준비 상태에 가깝지만 dependency 장애에서 모든 instance를 동시에 제외해 전체 outage를 만들 수 있다.

liveness와 readiness를 구분한다. 일시적으로 새 요청을 받지 못하는 instance를 restart할 필요는 없고, process가 복구 불가능한 상태인데 계속 traffic을 보내서도 안 된다. check interval, timeout, healthy/unhealthy threshold는 감지 속도와 일시적 흔들림 사이의 trade-off다.

## 분산 알고리즘 — 무엇을 균등하게 만들 것인가

- **round robin**은 요청 비용이 비슷하고 backend가 동질적일 때 단순하다. long-lived connection을 L4에서 분산하면 request 수는 불균등할 수 있다.
- **least connections**는 connection 길이가 다양한 경우 도움이 되지만 connection 수가 실제 작업량을 대표하지 않을 수 있다.
- **weighted 방식**은 instance capacity 차이를 반영하지만 weight calibration과 autoscaling 연동이 필요하다.
- **consistent hashing**은 key의 backend 변경을 줄여 cache locality나 session affinity에 유용하지만 hot key와 장애 시 재분배가 문제다.

session affinity는 stateful application을 쉽게 유지하지만 특정 backend 과부하와 failover 복잡성을 만든다. 가능하면 session state를 외부화하라는 조언도 그 외부 store latency·availability 비용을 동반한다.

## CDN — network와 origin 작업을 피하는 cache

CDN은 사용자 가까운 edge에서 cacheable response를 제공해 client-edge RTT만 지불하고 origin round trip과 계산을 피한다. 이득은 단순 bandwidth 절약보다 **긴 경로와 origin queue를 제거**하는 데 있다.

### cache key가 정확성과 hit ratio를 결정한다

기본 key는 대개 scheme, host, path, query 같은 요소로 구성되지만 제품과 설정에 따라 다르다. response가 `Accept-Language`, encoding, 인증 상태에 따라 달라지면 key 또는 `Vary`가 이를 구분해야 한다.

- key가 너무 좁으면 다른 사용자·representation의 response가 섞이는 correctness·보안 문제가 생긴다.
- key가 너무 넓으면 모든 요청이 고유해져 hit ratio가 무너진다.
- 무작위 query parameter나 cookie를 무조건 key에 넣으면 cache pollution이 생긴다.

### freshness, revalidation, stale

fresh object는 origin 접촉 없이 제공한다. stale object는 validator로 revalidate하거나 정책에 따라 오류·갱신 중 잠시 stale을 제공할 수 있다. stale serving은 availability와 latency를 높이지만 최신성 계약을 완화한다. 데이터 종류별로 허용 범위를 명시해야 한다.

cache miss가 동시에 몰리면 하나의 인기 object에 origin 요청이 폭증하는 cache stampede가 생긴다. request collapsing, background revalidation, TTL jitter는 이를 줄이지만 stale data와 구현 복잡성을 지불한다.

## TLS termination과 재암호화

edge에서 TLS를 끝내면 client와 edge 사이의 identity·encryption은 거기서 종료된다. edge-origin 구간을 다시 TLS로 보호하는 것은 별도 handshake와 certificate 검증이다. “HTTPS니까 origin까지 encrypted”라는 가정을 하지 않는다.

종단 위치마다 다음을 기록한다.

- 누가 어느 hostname의 certificate를 제시하는가
- plaintext에 접근하는 component는 무엇인가
- edge-origin identity를 어떻게 검증하는가
- session resumption key와 rotation 범위는 어디인가
- ALPN과 HTTP version이 각 구간에서 무엇인가

client-edge가 HTTP/3이어도 edge-origin은 HTTP/1.1 또는 2일 수 있다. client가 보고한 HTTP version은 전체 path의 version이 아니다.

## 전달 header와 신뢰 경계

proxy 뒤 application은 socket peer로 client IP를 직접 알 수 없다. `Forwarded`, `X-Forwarded-For`, PROXY protocol 같은 메커니즘으로 원 정보를 전달한다. 문제는 외부 client도 같은 HTTP header를 임의로 보낼 수 있다는 점이다.

안전한 기본 구조는 신뢰하는 edge가 외부에서 들어온 전달 header를 제거하거나 정규화하고 자기 관측을 추가하며, application은 지정된 proxy hop만 신뢰하는 것이다. 전체 문자열의 첫 IP를 무조건 client로 믿으면 IP 기반 authorization·rate limit·audit을 우회할 수 있다.

header 크기도 유한 자원이다. proxy마다 trace와 forwarding header를 계속 append하면 hop 수에 따라 커지고 서로 다른 header limit에서 431/400이 발생할 수 있다.

## timeout budget과 retry amplification

client timeout이 2초인데 proxy가 origin을 3초 기다리고 두 번 retry하면 client는 이미 떠난 뒤에도 backend 작업이 계속된다. 각 hop의 timeout은 바깥 deadline보다 작아야 하고 남은 budget을 전달해야 한다.

```text
client deadline 2000ms
└─ edge budget 1800ms
   └─ origin attempt 700ms + 제한된 retry/backoff
```

proxy 계층마다 독립적으로 3회 retry하면 최악의 시도 수가 곱해진다. retry 책임을 한 계층에 두고, 전체 budget·동시 retry·backoff·idempotency를 함께 제한한다. timeout은 원격 작업 취소나 rollback의 증거가 아니다.

## 관찰성 — 동일 요청을 구간별로 잇기

packet capture의 5-tuple은 proxy에서 바뀐다. end-to-end 진단에는 application-level request/trace ID와 시간 동기화가 필요하다.

최소 관측 집합:

| 위치 | 필요한 값 |
|---|---|
| client | DNS/connect/TLS/TTFB/total, remote IP, HTTP version |
| edge/LB | request ID, cache status, queue, upstream connect/header/total |
| origin | 같은 trace ID, handler·dependency 시간, 결과 상태 |
| transport | 구간별 RTT, retransmission, handshake 수, connection reuse |

trace ID는 연결 ID가 아니다. HTTP/2·3 한 연결에는 여러 요청이 있고 proxy는 upstream 연결을 여러 client가 공유할 수 있다. request 단위 correlation을 사용한다.

시계가 어긋나면 서로 다른 호스트의 timestamp subtraction이 거짓 지연을 만든다. 가능하면 각 hop이 자기 duration을 계산하고 시간 동기화 상태를 감시한다.

## 사례: TTFB 2초를 좁히기

1. client timing에서 DNS/TCP/TLS는 정상이고 TTFB만 2초다.
2. edge 로그에서 cache miss, 전체 2초, upstream connect 5ms, upstream first header 1.95초다.
3. regional LB는 queue 0, backend 연결 재사용을 보고한다.
4. origin trace에서 DB 20ms, handler 내부 외부 API 1.9초다.

이 증거는 “CDN이 느리다”와 “TCP가 느리다”를 낮추고 origin의 downstream dependency를 원인 구간으로 특정한다. 반대로 edge upstream connect가 길고 SYN 재전송이 보이면 origin application profile부터 보는 것은 순서가 틀리다.

## 실무 선택 체크리스트

- HTTP 내용 기반 정책이 필요한가, transport 분산이면 충분한가?
- TLS plaintext와 key를 어느 component까지 신뢰할 것인가?
- client·edge와 edge·origin 연결 재사용률을 각각 측정하는가?
- cache key가 모든 representation 차이를 포함하면서 불필요한 다양성은 제외하는가?
- health check가 dependency 장애를 전체 backend 제거로 증폭하지 않는가?
- timeout과 retry의 owner, 전체 deadline, idempotency 조건이 하나의 정책으로 정해졌는가?
- 전달 header와 trace context를 어느 hop부터 신뢰하는가?

## 정리

- proxy는 요청 경로를 여러 transport·TLS 구간으로 분리하고 각 구간에 독립 상태와 timeout을 만든다.
- L4는 작은 protocol coupling을, L7은 HTTP 기반 정책과 관찰성을 얻는다.
- health check와 분산 알고리즘은 무엇을 건강·부하로 간주하는지에 따라 failure mode가 달라진다.
- CDN의 핵심은 cache key 정확성과 긴 origin 경로 회피이며 hit ratio만으로 correctness를 판단할 수 없다.
- client·edge·origin duration과 request 단위 trace를 합쳐야 실제 병목 구간을 특정할 수 있다.

## 확인 문제

1. client는 HTTP/3을 보고하지만 origin capture에는 TCP가 있다. 모순이 아닌 이유는 무엇인가?
2. CDN hit ratio를 높이려고 authorization header를 cache key에서 제거했다. 어떤 조건과 보호 없이 위험한가?
3. 모든 proxy 계층이 timeout 시 3회 retry한다. 장애 때 어떤 현상이 생기며 어떻게 제한할 것인가?

<details>
<summary>정답과 해설</summary>

1. edge가 QUIC/TLS를 종단하고 origin에는 별도의 TCP+HTTP 연결을 만들 수 있다. HTTP version은 구간별 속성이다.
2. 사용자별 response가 shared cache에서 섞일 수 있다. 공개 cache 가능성, 인증 상태에 따른 representation, `private`/`Vary`와 key 설계를 명시해야 한다.
3. 계층별 retry 수가 곱해져 backend 부하와 꼬리 지연을 증폭한다. retry owner를 한 계층으로 제한하고 전체 deadline, attempt budget, backoff와 idempotency를 함께 적용한다.

</details>

## 참고 자료

- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html): intermediary, origin, connection과 forwarding의 공통 의미를 정의한다.
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html): shared cache의 freshness, validation, key 선택 규칙을 정의한다.
- [RFC 7239 — Forwarded HTTP Extension](https://www.rfc-editor.org/rfc/rfc7239.html): proxy가 원 client·protocol 정보를 전달하는 표준 header를 정의한다.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/): 여러 중개자를 지나는 request의 trace 식별자 전파 형식이다.
- [RFC 9218 — Extensible Prioritization Scheme for HTTP](https://www.rfc-editor.org/rfc/rfc9218.html): intermediary를 포함한 HTTP priority 신호의 현재 표준이다.
