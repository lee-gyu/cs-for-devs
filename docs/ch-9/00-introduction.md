# 9.0 네트워크 — 느린 요청을 구간과 증거로 분해하기

> 원격 요청의 지연은 하나의 숫자가 아니라 이름 해석, 경로 선택, 전송, 보안, 애플리케이션 처리가 합성한 결과다.

## 학습 목표

- 원격 요청의 전체 시간을 DNS, 연결, TLS, 첫 바이트, 본문 전송 구간으로 분해한다.
- 애플리케이션 timing, 소켓 상태, 패킷 캡처가 각각 답할 수 있는 질문을 구분한다.
- 지연·손실·처리량을 계층별 계약과 상태로 설명하는 학습 지도를 세운다.

## 배경: `3초 걸렸다`가 설명이 아닌 이유

주문 API의 p95가 평소 200ms에서 3초로 뛰었다고 하자. CPU와 데이터베이스는 정상이고 재시도하면 성공한다. 이때 “네트워크가 느리다”는 말은 원인을 다른 이름으로 바꿨을 뿐이다.

같은 3초도 전혀 다른 경로에서 생긴다.

- DNS 캐시가 비어 recursive resolver가 authoritative server까지 따라갔다.
- 연결 경로의 RTT가 커져 TCP와 TLS 핸드셰이크 왕복이 누적됐다.
- 패킷 하나가 손실되어 재전송을 기다렸다.
- HTTP 연결을 재사용하지 못해 매 요청마다 연결을 새로 만들었다.
- CDN은 빨랐지만 cache miss 뒤 origin이 늦었다.
- 응답 헤더는 빨리 왔지만 본문을 받는 동안 수신 측이나 중간 큐가 병목이 됐다.

필요한 능력은 프로토콜 이름을 많이 아는 것이 아니라 **관찰한 시간과 패킷을 어느 상태 변화에 귀속할지 판단하는 것**이다.

## 한 요청의 시간표

`curl`은 요청 시간을 몇 개의 누적 시점으로 보여 준다.

```text
0
├── time_namelookup   DNS 완료
├── time_connect      TCP 연결 완료
├── time_appconnect   TLS 완료
├── time_starttransfer 첫 응답 바이트
└── time_total        본문 수신 완료
```

```sh
curl -sS -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} ip=%{remote_ip} http=%{http_version}\n' \
  https://example.com/
```

각 값은 **누적 시점**이다. DNS 구간은 `time_namelookup`, TCP 구간은 `time_connect - time_namelookup`, TLS 구간은 `time_appconnect - time_connect`로 계산한다. TTFB에는 요청 전송, 서버·프록시 처리, 첫 응답 바이트의 왕복이 모두 들어간다. 따라서 TTFB 하나만 보고 origin CPU가 느리다고 결론 내릴 수 없다.

브라우저 DevTools의 waterfall도 같은 모델을 더 많은 리소스에 적용한다. 다만 queued/stalled 시간은 브라우저의 연결 한도와 우선순위 같은 클라이언트 내부 대기도 포함한다. 도구의 필드 이름이 같아 보여도 경계를 먼저 확인해야 한다.

## 세 층의 증거

### 애플리케이션 timing — 어디가 길었는가

`curl -w`, DevTools, 프록시 access log, distributed trace는 요청 구간을 빠르게 좁힌다. 운영에서 가장 먼저 볼 증거다. 그러나 TCP가 왜 늦었는지, cache miss 뒤 어느 연결에서 손실이 났는지는 숨긴다.

### 소켓 상태 — 운영체제가 무엇을 알고 있는가

Linux의 `ss -ti`는 RTT 추정, 재전송, congestion window 같은 TCP 상태를 보여 준다. 애플리케이션 요청과 소켓의 관계를 알고 있다면 “서버 처리”와 “전송 정체” 가설을 가르는 데 유용하다. 소켓이 이미 닫혔거나 여러 요청이 한 연결을 공유하면 사후 대응이 어려울 수 있다.

### 패킷 — 실제로 무엇이 오갔는가

`tcpdump`와 Wireshark는 DNS 질의, SYN, ACK, TLS record, 재전송의 시간과 순서를 보여 준다. 가장 세밀하지만 항상 진실 전체를 주지는 않는다. 캡처 위치 바깥의 큐, NIC offload, 암호화된 애플리케이션 데이터는 보이지 않는다. 패킷 캡처는 가설 없이 열어 보는 첫 도구가 아니라, 좁힌 가설을 검증하는 증거다.

## 계층은 책임의 경계다

TCP/IP 계층을 암기표가 아니라 실패와 보장의 경계로 읽는다.

| 계층 | 이 챕터의 질문 | 대표 증거 |
|---|---|---|
| 이름·인터넷 | 어느 주소와 다음 홉을 선택했는가 | `dig`, `ip route`, `tracepath` |
| 전송 | 손실·순서·수신 속도·혼잡을 어떻게 다루는가 | `ss -ti`, TCP 패킷 |
| 보안 | 누구와 어떤 키·프로토콜을 합의했는가 | TLS handshake, 인증서, ALPN |
| HTTP | 메시지를 연결과 stream에 어떻게 배치하는가 | waterfall, frame, cache header |
| 중개자 | 어느 구간에서 연결·TLS·캐시가 끊기는가 | proxy/origin timing, trace ID |

계층화가 주는 핵심 이득은 독립적 진화다. IP는 payload가 TCP인지 UDP인지 몰라도 전달하고, TCP는 byte stream의 의미가 주문인지 이미지인지 모른다. 그 대가는 **하위 계층의 성공이 상위 계층의 성공을 뜻하지 않는다**는 점이다. TCP ACK는 수신 호스트 커널이 바이트를 받았다는 뜻이지 주문이 커밋됐다는 뜻이 아니다.

## 지연, 처리량, 손실은 별개의 축이다

- **지연 시간(latency)**은 한 작업이 완료될 때까지의 시간이다. 전파, 큐잉, 처리, 직렬화 지연이 합쳐진다.
- **대역폭(bandwidth)**은 링크가 단위 시간에 옮길 수 있는 상한이다.
- **처리량(throughput)**은 실제로 전달한 유효 데이터의 속도다. 프로토콜 overhead, 수신 창, 혼잡 창, 손실 때문에 대역폭보다 작다.
- **손실(loss)**은 패킷이 목적지까지 가지 못한 사건이다. TCP에서는 재전송 지연으로, UDP 애플리케이션에서는 누락 또는 자체 복구 비용으로 나타난다.

대역폭이 큰 회선도 RTT가 크고 전송 중인 데이터 양이 작으면 처리량이 낮다. 반대로 RTT가 낮아도 큐가 과도하게 쌓이면 부하 순간 p99가 튄다. 이후 문서들은 이 축들을 섞지 않고 측정한다.

## 챕터 학습 지도

1. [9.1 이름에서 다음 홉까지](./01-internet-path-and-dns.md)는 DNS, 주소, 라우팅, NAT, MTU가 패킷 경로를 결정하는 방식을 다룬다.
2. [9.2 신뢰 가능한 전송의 비용](./02-transport-reliability-and-congestion.md)은 TCP가 손실과 혼잡을 견디는 상태와 UDP가 다른 계약을 선택한 이유를 다룬다.
3. [9.3 HTTP의 진화](./03-http-evolution.md)는 HTTP/1.1과 2가 요청을 연결에 배치하는 방식과 병목 이동을 다룬다.
4. [9.4 TLS, QUIC, HTTP/3](./04-tls-quic-and-http3.md)은 보안 핸드셰이크와 새로운 전송이 왕복·HOL 비용을 바꾸는 방식을 다룬다.
5. [9.5 프록시·로드 밸런서·CDN](./05-proxies-load-balancers-and-cdns.md)은 프로덕션 경로가 여러 연결과 신뢰 경계로 분절되는 현실을 다룬다.

마지막 통합 실습(`exercises/ch-9/README.md`)에서는 클라이언트–프록시–원 서버 토폴로지에 RTT·손실·캐시 조건을 주입하고 패킷 분석 리포트를 작성한다.

## 정리

- 요청 시간은 DNS, 연결, TLS, TTFB, 본문 전송 구간으로 먼저 나눈다.
- 애플리케이션 timing은 범위를 좁히고, 소켓 상태와 패킷은 전송 가설을 검증한다.
- 계층은 책임 경계이며 하위 계층의 성공은 상위 업무의 성공을 보장하지 않는다.
- 지연, 대역폭, 처리량, 손실을 독립 변수로 구분해야 올바른 실험을 설계할 수 있다.

## 확인 문제

1. `time_connect`만 크게 증가했다. DNS와 서버 처리 중 어느 가설의 우선순위가 낮아지며, 다음으로 어떤 증거를 수집해야 하는가?
2. TCP ACK를 받았지만 클라이언트는 타임아웃됐다. 주문이 실행되지 않았다고 결론 내릴 수 없는 이유는 무엇인가?

<details>
<summary>정답과 해설</summary>

1. DNS는 `time_namelookup`으로 이미 분리되고 서버 처리는 연결 이후이므로 우선순위가 낮다. TCP SYN/SYN-ACK 간격, 재시도 SYN, 선택된 원격 주소를 캡처와 `ss`로 확인한다.
2. ACK는 상대 커널의 byte stream 수신을 확인할 뿐 애플리케이션 처리와 커밋을 확인하지 않는다. 서버의 업무 식별자·로그·저장 상태를 별도로 조회해야 한다.

</details>

## 참고 자료

- [RFC 1122 — Requirements for Internet Hosts](https://www.rfc-editor.org/rfc/rfc1122.html): 인터넷 호스트의 계층별 요구사항과 책임 경계를 확인한다.
- [curl write-out variables](https://curl.se/docs/manpage.html#-w): 요청 구간별 timing 필드의 정확한 의미를 확인한다.
- [Wireshark User's Guide](https://www.wireshark.org/docs/wsug_html_chunked/): 캡처·필터·TCP 분석 기능의 공식 사용 지침이다.
