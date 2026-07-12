# 9.3 HTTP의 진화 — 연결 재사용, 다중화와 head-of-line blocking

> HTTP 버전은 resource 의미를 바꾸기보다 같은 메시지를 연결에 배치하는 방식과 병목의 위치를 바꾸었다.

## 학습 목표

- HTTP 의미론과 버전별 wire format을 구분한다.
- HTTP/1.1 연결 재사용·병렬 연결의 비용과 pipelining의 한계를 설명한다.
- HTTP/2 frame·stream·flow control이 다중화를 구현하는 방식을 설명한다.
- 애플리케이션 계층과 TCP 계층의 head-of-line blocking을 구분한다.

## 배경: `GET`은 같지만 운반법은 다르다

HTTP는 resource에 대한 request/response 의미론을 제공한다. `GET`의 안전성, status code, cache validator 같은 의미는 HTTP/1.1·2·3에 공통이다. 달라지는 것은 메시지를 serialize하고 transport에 배치하는 방식이다.

이 구분이 중요하다. HTTP/2로 바꿔도 잘못된 cache 정책이나 비멱등 요청의 retry 위험은 고쳐지지 않는다. 반대로 애플리케이션 코드를 바꾸지 않아도 연결 수와 header encoding, 다중화가 달라져 network 성능이 바뀔 수 있다.

## HTTP/1.1 — text message와 persistent connection

HTTP/1.1 message는 start-line, header field, 빈 줄, 선택적인 body로 구성된다.

```http
GET /orders/42 HTTP/1.1
Host: api.example.test
Accept: application/json

```

message 길이는 `Content-Length`, transfer coding, method/status 의미 등 명시적 framing 규칙으로 결정한다. TCP 연결 종료만 message 경계로 의존하면 연결 재사용이 불가능하고 모호한 parsing은 request smuggling 같은 보안 경계를 만든다.

HTTP/1.1의 중요한 개선은 persistent connection이 기본이라는 점이다. 한 TCP/TLS 연결에서 여러 request를 순차적으로 처리해 매번 handshake와 slow start를 다시 내지 않는다.

```text
connection 1: request A → response A → request B → response B
```

### pipelining은 왜 널리 쓰이지 못했는가

client가 response를 기다리지 않고 A, B를 연속 전송할 수는 있지만 server는 response를 요청 순서대로 보내야 한다. A가 느리면 준비된 B도 앞을 지나갈 수 없다. 이것이 HTTP/1.1 application-layer head-of-line(HOL) blocking이다. 중개자 호환성, 실패한 pipeline의 retry 의미도 복잡해 브라우저에서는 널리 정착하지 못했다.

대신 브라우저는 origin에 TCP 연결을 여러 개 열어 병렬성을 얻었다. 느린 A가 connection 1만 막고 B는 connection 2에서 진행한다. 그러나 연결마다 handshake, buffer, congestion state를 갖고 서로 bandwidth를 경쟁한다. domain sharding은 이 연결 한도를 우회하지만 DNS·TLS 비용과 관리 복잡성을 늘린다.

## HTTP/2 — message를 frame과 stream으로 분해한다

HTTP/2는 하나의 연결 안에 여러 양방향 stream을 만들고 각 HTTP message를 HEADERS와 DATA 같은 binary frame으로 나눈다. frame에는 stream identifier가 있으므로 transport의 byte stream에서 서로 섞여 와도 HTTP/2 layer가 각 message로 재조립한다.

```text
TCP byte stream:
[stream 1 HEADERS][stream 3 HEADERS][stream 1 DATA][stream 3 DATA]...
```

stream 1의 application 처리가 느려도 stream 3 frame을 보낼 수 있어 HTTP/1.1의 순서 강제 HOL을 제거한다. 연결 하나를 공유하므로 handshake와 congestion state를 재사용하고 작은 객체가 많은 page에서 특히 유리하다.

### header compression

HTTP request는 cookie, user-agent, accept 같은 header를 반복한다. HTTP/2의 HPACK은 connection별 dynamic table과 정적 table을 사용해 중복을 줄인다. 압축 상태를 공유한다는 것은 양 끝이 같은 table 상태를 유지해야 한다는 뜻이며, 잘못된 크기 제한이나 민감 header 압축은 memory와 보안 고려를 만든다.

### stream과 connection flow control

HTTP/2에는 stream별 window와 connection 전체 window가 있다. receiver가 처리하지 못한 DATA가 memory를 무한히 차지하지 않게 한다. 특정 stream window가 0이면 그 stream만 멈출 수 있지만 connection window가 고갈되면 모든 DATA stream이 멈춘다. TCP의 rwnd/cwnd와는 또 다른 상위 계층 제어다.

```text
application stream window
        ↓
HTTP/2 connection window
        ↓
TCP receive window / congestion window
```

성능 문제에서 어느 window가 닫혔는지 구분해야 한다.

## 남은 TCP HOL — packet 하나가 모든 stream을 막는다

HTTP/2는 HTTP message의 순서 의존을 없앴지만 아래에는 하나의 ordered TCP byte stream이 있다. stream 1 frame이 담긴 TCP segment가 손실되고 그 뒤에 stream 3 frame이 도착해도, TCP는 누락 byte를 복구하기 전 뒤 byte를 애플리케이션에 넘기지 않는다. HTTP/2 layer는 stream 3 frame이 도착했다는 사실조차 아직 볼 수 없다.

```text
TCP bytes: [S1 frame 일부 LOST][S3 frame 도착]
           └ 복구 전 HTTP/2에는 S3도 전달되지 않음
```

이것이 transport-layer HOL이다. 손실이 거의 없고 RTT가 낮은 환경에서는 한 연결 다중화의 이득이 크다. 손실이 잦은 이동망에서는 단일 손실이 모든 활성 stream의 지연에 보인다. [HTTP/3](./04-tls-quic-and-http3.md)는 독립된 transport stream으로 이 경계를 바꾼다.

## cache — 가장 빠른 전송은 보내지 않는 것이다

HTTP cache는 network round trip과 origin 작업을 피한다. 핵심은 freshness와 validation이다.

- `Cache-Control: max-age=60`은 저장된 response가 60초 동안 fresh하다는 정책을 전달한다.
- stale response는 `If-None-Match`/`ETag` 또는 `If-Modified-Since`로 revalidate할 수 있다. `304 Not Modified`는 body 전송을 피하지만 왕복 자체는 남는다.
- `no-store`는 저장 금지이고 `no-cache`는 저장할 수 있으나 재사용 전 validation이 필요하다는 뜻이다. 이름만 보고 둘을 같은 것으로 취급하면 안 된다.

shared cache에서는 `Vary`가 cache key를 확장한다. `Vary: Accept-Encoding`이 없으면 gzip과 identity representation이 섞일 수 있고, 지나치게 다양한 `Vary`는 hit ratio를 낮춘다. 인증·개인화 응답은 공개 cache 가능 여부를 명시적으로 설계한다.

## streaming과 backpressure

HTTP response는 전체 body가 준비되기 전에 stream할 수 있다. TTFB는 좋아지지만 전체 완료 시간이나 사용자에게 필요한 핵심 데이터 도착이 빨라졌다고 자동으로 결론 내릴 수 없다. receiver가 느리면 HTTP/2 flow control, TCP rwnd, 결국 sender의 write까지 backpressure가 전파돼야 memory가 유한하게 유지된다.

버퍼링하는 reverse proxy가 중간에 있으면 origin은 stream해도 client는 큰 chunk가 모인 뒤에야 받을 수 있다. application code만 보지 말고 모든 중개자의 buffering 정책을 확인한다.

## 관찰: 연결과 다중화 찾기

```sh
curl -sS -o /dev/null -w '%{http_version} %{num_connects} %{time_connect} %{time_starttransfer}\n' \
  --parallel --parallel-immediate --http1.1 \
  https://example.test/a https://example.test/b

curl -sS -o /dev/null -w '%{http_version} %{num_connects} %{time_connect} %{time_starttransfer}\n' \
  --parallel --parallel-immediate --http2 \
  https://example.test/a https://example.test/b
```

실제 curl build가 HTTP/2와 parallel mode를 지원하는지 `curl --version`과 도움말로 확인한다. 여러 URL을 한 process에서 요청해야 connection cache를 공유할 수 있다. `num_connects`와 패킷의 SYN 수, DevTools의 Connection ID를 대응시킨다. 첫 실행은 DNS와 연결 setup이 섞이므로 warm connection 대조군을 별도로 둔다.

작은 객체 여러 개를 순차와 병렬로 요청하고 RTT를 주입하면 차이가 잘 보인다. 단, 브라우저 cache·service worker·preconnect가 결과를 바꿀 수 있으므로 disable cache와 새 profile 같은 통제를 기록한다.

## 실무 판단

- HTTP/2가 항상 빠른 것은 아니다. request 하나, 낮은 RTT, 작은 payload에서는 차이가 작고 frame·compression overhead가 더해질 수 있다.
- connection 수를 줄이는 것이 항상 좋은 것도 아니다. 단일 connection 장애 범위와 TCP HOL을 키울 수 있다.
- TTFB 개선과 total time 개선을 구분한다. streaming은 첫 byte를 앞당기지만 느린 생성·전송을 없애지 않는다.
- server push는 HTTP/2의 본질이 아니다. modern deployment에서 일반적 최적화로 가정하지 말고 실제 client·cache 동작을 확인한다.

## 정리

- HTTP semantics는 버전 공통이고 wire framing과 connection 배치가 버전별로 다르다.
- HTTP/1.1 persistent connection은 handshake를 재사용하지만 한 연결의 response 순서가 HOL을 만든다.
- HTTP/2는 frame과 stream으로 application HOL을 줄이고 header·connection 상태를 공유한다.
- HTTP/2 아래 TCP의 ordered byte stream 때문에 packet loss는 모든 stream을 잠시 막을 수 있다.
- cache와 connection reuse는 전송 자체를 피하거나 setup 비용을 상각하는 가장 큰 지렛대다.

## 확인 문제

1. HTTP/2인데 작은 packet loss 하나에서 모든 요청의 waterfall이 동시에 멈췄다. application stream 구현만 조사하면 부족한 이유는 무엇인가?
2. `Cache-Control: no-cache`를 응답 저장 금지로 이해한 설정의 오류를 설명하라.
3. TTFB는 줄었지만 total time이 같고 proxy 뒤에서만 재현된다. 어떤 가설과 증거를 우선할 것인가?

<details>
<summary>정답과 해설</summary>

1. 모든 HTTP/2 stream이 하나의 ordered TCP byte stream을 공유하므로 누락 byte 복구 전 뒤 frame이 HTTP/2에 전달되지 않는다. TCP 재전송과 RTT를 확인한다.
2. `no-cache`는 저장 가능하되 재사용 전 validation을 요구한다. 저장 자체 금지는 `no-store`다.
3. proxy buffering 가설을 세운다. origin의 첫 DATA 시점, proxy upstream header/body timing, client 첫 byte 시점을 같은 trace ID로 비교한다.

</details>

## 참고 자료

- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html): 버전 공통 method·status·resource 의미를 정의한다.
- [RFC 9112 — HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112.html): HTTP/1.1 message framing과 connection 관리를 정의한다.
- [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html): frame, stream, flow control, HPACK 사용의 기준이다.
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html): freshness, validation, shared cache 규칙을 정의한다.
