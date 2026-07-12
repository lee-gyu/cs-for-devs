# 9.4 보안 연결과 새로운 전송 — TLS 1.3, QUIC과 HTTP/3

> TLS는 보안 계약을, QUIC은 보안과 전송 상태를 한 handshake에 조립한다. 줄어든 왕복과 독립 stream에는 재개·운영·보안 비용이 따른다.

## 학습 목표

- TLS 1.3 handshake의 인증·키 합의·protocol 협상과 왕복 비용을 설명한다.
- session resumption과 0-RTT가 줄이는 비용과 replay 경계를 판단한다.
- QUIC의 packet·stream·connection ID가 TCP와 다른 실패 격리를 만드는 방식을 설명한다.
- HTTP/3이 유리한 조건과 TCP+HTTP/2가 여전히 합리적인 조건을 구분한다.

## 배경: encryption은 포장지가 아니다

HTTPS 요청 전 client와 server는 암호화 방식과 key를 합의하고 server가 해당 이름을 대표할 권한이 있는지 검증한다. 이 handshake는 network 왕복, CPU, 인증서 전달을 추가하지만 도청·변조·사칭을 막는다. 성능 최적화는 이 보장을 제거하는 일이 아니라 안전하게 상태를 재사용하는 일이다.

암호의 수학과 인증서 신뢰 사슬은 챕터 3에서 다룬다. 여기서는 packet 왕복, protocol 선택, 실패 지점을 본다.

## TLS 1.3 handshake — 무엇을 합의하는가

새 TCP 연결 위의 전형적인 TLS 1.3 흐름을 단순화하면 다음과 같다.

```text
client                                      server
ClientHello
  key_share, supported_versions,
  SNI, ALPN ------------------------------->
                       ServerHello, key_share
                       EncryptedExtensions
                       Certificate, CertificateVerify
                       Finished <-------------
Finished ---------------------------------->
application data <=========================>
```

ClientHello에는 client가 지원하는 TLS version과 key share가 들어간다. server는 선택 결과와 자기 key share를 보내고 certificate와 signature로 인증한다. 양쪽 Finished는 지금까지의 handshake transcript와 key가 일치함을 확인한다. TLS 1.3은 적절한 key share가 첫 ClientHello에 있으면 보통 1 RTT 뒤 client application data를 보낼 수 있다.

TCP 위에서는 그 전에 TCP handshake 1 RTT가 필요하다. 새 HTTPS 연결은 대략 `TCP 1 RTT + TLS 1 RTT`의 setup을 지불한다. 실제 소요는 certificate 크기, packet loss, server CPU, retry에 따라 달라진다.

### SNI와 ALPN

- Server Name Indication(SNI)은 하나의 IP에서 여러 hostname을 제공할 때 client가 원하는 이름을 TLS handshake에 전달한다. 잘못된 SNI는 default certificate나 handshake 거부로 나타난다.
- Application-Layer Protocol Negotiation(ALPN)은 `h2`, `http/1.1`, `h3`처럼 TLS 위에서 사용할 protocol을 합의한다. port 443이 같다고 HTTP version이 같은 것이 아니다.

```sh
openssl s_client -connect example.com:443 -servername example.com -alpn h2 </dev/null
curl -v --http2 https://example.com/
```

`openssl` 출력에서 certificate chain, verification result, negotiated protocol을 확인한다. `-servername`을 빼거나 다른 이름으로 바꾸는 실험은 SNI와 certificate 선택의 관계를 보여 주지만 public service에 과도하게 반복하지 않는다.

## certificate 실패를 시간 구간에 놓기

인증서 만료, hostname 불일치, 신뢰하지 않는 issuer, 중간 인증서 누락, client 시계 오류는 TCP 연결 성공 뒤 TLS 단계에서 실패한다. 따라서 connect 성공과 HTTPS 성공을 구분한다. 단순 `telnet host 443`은 port reachability만 확인한다.

서버가 보내는 certificate chain이 불필요하게 크면 handshake가 여러 packet으로 나뉘고 초기 congestion window와 손실 영향을 더 받는다. 반대로 중간 인증서를 누락하면 일부 client는 cache된 chain 덕분에 성공하고 새 client만 실패하는 편차가 생길 수 있다.

## session resumption — 인증 결과를 안전하게 재사용한다

완전한 handshake 뒤 server는 PSK 기반 재개 정보를 제공할 수 있다. 다음 연결에서 client는 이전 session과 연결된 key material을 증명하고 certificate 인증과 key 합의의 일부 비용을 줄인다. 재개는 같은 TCP connection을 계속 쓰는 keep-alive와 다르다. 전자는 **새 연결의 handshake를 단축**하고 후자는 연결 자체를 재사용한다.

재개 효율은 ticket lifetime, key rotation, 여러 server 간 key 공유, client cache에 달려 있다. 로드 밸런서 뒤 instance마다 재개 key가 다르면 연결은 성공해도 full handshake 비율이 높아진다. 성능 지표는 handshake latency뿐 아니라 full/resumed 비율을 함께 본다.

## 0-RTT — 빠르지만 replay 가능한 early data

TLS 1.3 재개 client는 일부 application data를 첫 flight에 보낼 수 있다. 0-RTT는 이름 그대로 application data 전송 전에 추가 왕복을 기다리지 않는다는 뜻이지 지연이 0이라는 뜻이 아니다.

early data는 완전한 새 handshake와 같은 replay 보호를 제공하지 않는다. 공격자가 유효한 0-RTT ciphertext를 복제해 server가 여러 번 처리하게 만들 수 있다. 따라서 조회처럼 replay되어도 안전한 작업에 제한하고 결제·주문 생성 같은 비멱등 side effect에는 사용하지 않는다. application이 method 이름만 믿지 않고 실제 업무 의미와 idempotency protection을 확인해야 한다.

## QUIC — UDP 위에서 다시 만든 secure transport

QUIC version 1은 UDP datagram 안에 자체 packet을 싣고 TLS 1.3을 handshake에 통합한다. 신뢰성·loss recovery·congestion control을 없앤 것이 아니라 user space에서 다시 구현한다.

```text
UDP datagram
└── QUIC packet
    ├── connection ID / packet number
    └── frames
        ├── STREAM(stream id, offset, data)
        ├── ACK
        ├── CRYPTO
        └── flow-control frames
```

### packet number와 ACK

QUIC packet number는 재전송 때 새 번호를 사용한다. 손실된 packet의 data는 새 packet의 frame으로 다시 실릴 수 있어 “같은 packet 재전송”보다 loss와 ACK 해석이 명확하다. ACK range는 받은 packet 구간을 알린다. QUIC도 RTT를 추정하고 congestion window를 관리한다.

### 독립 stream과 loss 격리

각 stream은 자기 offset과 순서를 가진다. stream 1 data가 담긴 packet이 손실돼도 이미 도착한 stream 3 data는 application에 전달할 수 있다. HTTP/2 over TCP에서 transport byte 하나의 손실이 모든 stream을 막던 경계를 줄인다.

같은 stream 안의 누락은 여전히 뒤 data를 막는다. congestion control도 connection path를 공유하므로 손실 뒤 전송률 감소는 다른 stream에 영향을 줄 수 있다. “QUIC에는 HOL이 없다”보다 **stream 간 delivery HOL을 제거했다**고 표현하는 것이 정확하다.

### connection ID와 migration

TCP 연결은 address와 port tuple에 강하게 묶인다. mobile client가 Wi-Fi에서 cellular로 바뀌면 주소가 달라져 새 연결이 필요하다. QUIC은 connection ID로 논리 연결을 식별하고 새 path를 validation한 뒤 migration할 수 있다. NAT rebinding에도 강하다.

이 기능은 무료가 아니다. server는 connection ID routing과 상태를 관리해야 하고 migration 중 새 path의 congestion 상태를 검증해야 한다. load balancer가 QUIC connection을 올바른 backend로 보내는 설계도 필요하다.

### handshake 통합

QUIC은 transport와 TLS 협상을 같은 packet 흐름에 넣어 새 연결에서 TCP+TLS의 순차 RTT를 줄일 수 있다. 재개 연결에서는 0-RTT도 가능하다. 그러나 첫 연결의 DNS, 물리 RTT, server 처리 시간이 사라지는 것은 아니다.

## HTTP/3 — HTTP semantics를 QUIC에 매핑한다

HTTP/3은 HTTP semantics를 QUIC stream과 frame에 매핑한다. request마다 QUIC stream을 사용해 packet loss의 stream 간 delivery HOL을 피한다. HPACK 대신 QPACK을 사용한다. header compression의 동적 상태가 stream 독립성을 다시 막지 않도록 별도 encoder/decoder stream과 blocking 제한을 둔다.

client는 보통 HTTPS origin에 처음부터 UDP를 무작정 보내는 대신 DNS HTTPS record나 이전 HTTP response의 `Alt-Svc` 같은 신호로 HTTP/3 endpoint를 발견한다. UDP path가 막히면 HTTP/2로 fallback할 수 있어야 한다. HTTP/3 rollout에서는 성공률뿐 아니라 fallback 지연을 관찰한다.

## 관찰과 복호화 경계

```sh
curl --version              # HTTP3 지원 여부 확인
curl -v --http3 https://example.com/
tcpdump -i any -nn 'udp port 443 or tcp port 443'
```

배포판 curl이 HTTP/2는 지원해도 HTTP/3를 지원하지 않을 수 있다. option 존재를 가정하지 말고 build feature를 먼저 기록한다.

TLS와 QUIC application payload는 암호화되므로 capture만으로 HTTP header를 읽을 수 없다. 통제된 실습에서는 client가 내보낸 TLS key log를 Wireshark에 제공할 수 있지만 key log 자체가 민감 정보다. 운영 capture와 함께 보관하거나 저장소에 commit하지 않는다. 암호화를 풀지 않아도 packet size, timing, handshake type, loss·ACK pattern은 관찰할 수 있다.

## HTTP/3 선택 기준

HTTP/3이 특히 유리한 신호:

- RTT가 크고 연결 이동이 잦은 mobile client
- 여러 stream을 다중화하며 path loss가 TCP HOL로 꼬리 지연을 키우는 workload
- client·edge가 QUIC을 지원하고 UDP 443 성공률과 fallback을 측정할 수 있는 환경

HTTP/2가 충분하거나 더 단순한 신호:

- loss가 낮은 datacenter 내부 짧은 경로
- 요청 수가 적고 기존 connection을 오래 재사용하는 workload
- UDP가 제한되거나 observability·load balancing·보안 장비의 QUIC 지원이 부족한 환경

protocol 이름만으로 결정하지 않는다. 같은 endpoint에서 connection reuse, full/resumed handshake, fallback, p50/p95, CPU를 함께 비교한다.

## 실무 관점: 최적화의 우선순위

1. connection을 재사용해 handshake 자체를 피한다.
2. 새 연결이 필요하면 TLS resumption의 성공률을 높인다.
3. 0-RTT는 replay-safe operation에만 적용한다.
4. HTTP/3은 실제 client network 분포에서 A/B 측정하고 TCP fallback을 보존한다.

QUIC으로 전환하기 전에 매 요청마다 새 연결을 만드는 문제를 고치는 편이 효과가 더 클 수 있다.

## 정리

- TLS 1.3은 인증·key 합의·ALPN을 보통 1 RTT handshake에 수행하며 TCP setup은 별도다.
- session resumption은 새 연결의 handshake를 줄이고 keep-alive는 연결 자체를 재사용한다.
- 0-RTT early data는 replay 위험 때문에 업무 의미가 안전한 요청에 제한한다.
- QUIC은 UDP 위에 stream, loss recovery, congestion control, TLS를 구성하고 connection ID로 경로 변경을 견딘다.
- HTTP/3은 stream 간 delivery HOL을 줄이지만 모든 loss 영향과 운영 비용을 제거하지 않는다.

## 확인 문제

1. TCP connect는 성공하지만 client마다 인증서 오류 여부가 다르다. 가능한 가설 두 개와 수집할 증거를 제시하라.
2. 결제 생성 API에 TLS 0-RTT를 적용하면 안 되는 이유는 무엇인가?
3. HTTP/3에서 stream 1 packet 손실 뒤 stream 3은 진행했다. 그래도 전체 처리량이 낮아질 수 있는 이유는 무엇인가?

<details>
<summary>정답과 해설</summary>

1. SNI에 따라 다른 chain을 제공하거나 server가 intermediate를 누락해 일부 client cache에서만 성공할 수 있다. client별 SNI, 제공 chain, trust store, 시각, verification result를 비교한다.
2. early data는 transport 수준의 완전한 replay 보호가 없어 같은 ciphertext가 여러 번 처리될 수 있다. 업무 idempotency가 별도로 보장되지 않으면 중복 결제가 가능하다.
3. stream 간 delivery는 독립적이어도 connection path의 congestion controller가 loss에 반응해 cwnd를 줄인다. 공유 bandwidth와 server CPU도 그대로다.

</details>

## 참고 자료

- [RFC 8446 — TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html): handshake, PSK resumption, 0-RTT와 보안 속성을 정의한다.
- [RFC 9000 — QUIC](https://www.rfc-editor.org/rfc/rfc9000.html): QUIC packet, stream, connection ID와 migration의 기준이다.
- [RFC 9001 — Using TLS to Secure QUIC](https://www.rfc-editor.org/rfc/rfc9001.html): QUIC과 TLS 1.3의 결합을 정의한다.
- [RFC 9002 — QUIC Loss Detection and Congestion Control](https://www.rfc-editor.org/rfc/rfc9002.html): RTT, loss detection, congestion control의 기준이다.
- [RFC 9114 — HTTP/3](https://www.rfc-editor.org/rfc/rfc9114.html): HTTP semantics를 QUIC에 매핑하는 방식과 endpoint discovery를 정의한다.
