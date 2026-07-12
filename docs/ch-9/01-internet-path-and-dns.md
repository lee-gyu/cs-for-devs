# 9.1 이름에서 다음 홉까지 — DNS, IP, 라우팅과 MTU

> 호스트 이름은 주소로 해석되고, 주소는 라우팅 테이블에서 다음 홉으로 바뀌며, 각 홉은 독립적으로 패킷을 전달한다.

## 학습 목표

- DNS의 재귀 해석과 캐시가 지연·실패에 미치는 영향을 설명한다.
- CIDR과 longest prefix match로 실제 다음 홉 선택을 예측한다.
- NAT, 이중 스택, MTU가 end-to-end 연결에 만드는 경계 조건을 진단한다.
- `dig`, `ip route`, `tracepath`의 관찰 결과와 한계를 구분한다.

## 배경: URL에는 경로가 없다

애플리케이션은 `api.example.test`라는 이름을 사용하지만 IP 라우터는 이 이름을 보지 않는다. 먼저 DNS가 이름을 주소로 바꾸고, 각 호스트와 라우터는 목적지 주소를 라우팅 테이블과 비교해 다음 홉을 고른다. 이 두 단계가 모두 성공해도 왕복 경로가 같거나 모든 크기의 패킷이 통과한다는 보장은 없다.

## DNS — 분산된 위임과 캐시

### 누가 답하는가

일반 애플리케이션은 운영체제의 stub resolver에 질의를 맡긴다. stub은 설정된 recursive resolver에 “최종 답을 찾아 달라”고 요청한다. recursive resolver의 캐시에 답이 없으면 root, TLD, authoritative name server의 위임을 따라간다.

```text
application → stub → recursive resolver
                          ├→ root: .com은 어디인가
                          ├→ .com: example.com은 어디인가
                          └→ authoritative: api.example.com의 A/AAAA는 무엇인가
```

root가 모든 주소를 저장하는 것이 아니다. 각 단계가 다음 권한 영역의 name server를 알려 주는 **위임(delegation)** 구조다. authoritative server는 자신이 맡은 zone의 정답을 제공하고 recursive resolver는 결과를 클라이언트 대신 조립한다.

### TTL은 일관성과 부하의 가격표다

resource record의 TTL 동안 resolver는 답을 재사용한다. 긴 TTL은 지연과 DNS 부하를 줄이지만 주소 변경 전파를 늦춘다. 짧은 TTL은 전환을 빠르게 하지만 질의량과 resolver 의존성을 키운다. TTL이 만료됐다고 기존 TCP 연결이 끊기는 것도 아니다. DNS는 새 연결의 주소 선택에 영향을 주고 이미 열린 연결의 수명은 전송 계층이 관리한다.

존재하지 않는 이름이나 record type의 부재도 **negative caching**될 수 있다. 배포 직후 record를 추가했는데 일부 사용자만 계속 NXDOMAIN을 받는다면 positive TTL만 볼 것이 아니라 SOA 기반 negative TTL을 확인해야 한다.

### UDP, TCP, 암호화 DNS

전통적 DNS는 주로 UDP 53을 사용하지만 응답이 잘렸거나 zone transfer 같은 경우 TCP를 사용한다. “DNS는 UDP”라는 암기는 계약이 아니다. DoT와 DoH는 resolver까지의 질의를 TLS나 HTTPS로 보호하지만 authoritative 위임 모델과 record 의미를 바꾸지는 않는다. 진단에서는 브라우저가 OS와 다른 resolver 경로를 사용하는지도 확인해야 한다.

관찰:

```sh
dig api.example.com A
dig api.example.com AAAA
dig +trace api.example.com
```

첫 명령의 `SERVER`, `Query time`, `ANSWER SECTION`, TTL을 기록한다. `+trace`는 로컬 recursive resolver의 실제 내부 동작을 그대로 캡처하는 명령이 아니라, 클라이언트가 위임을 직접 따라가 보는 별도 실험이다.

## IP 주소와 prefix — 어느 네트워크에 속하는가

IPv4 주소는 32비트이고 CIDR prefix는 앞쪽 몇 비트가 네트워크 식별자인지 나타낸다. `10.20.30.40/24`에서 `/24`는 앞 24비트가 prefix이고 나머지가 해당 네트워크 안의 주소다. 라우터는 “같은 /24인가”만 보는 것이 아니라 라우팅 테이블의 여러 prefix 중 **가장 긴 일치(longest prefix match)**를 고른다.

```text
10.0.0.0/8       via gateway-A
10.20.0.0/16     via gateway-B
10.20.30.0/24    via gateway-C
default          via gateway-D
```

목적지 `10.20.30.40`에는 세 prefix가 모두 맞지만 가장 구체적인 `/24`가 선택된다. 일치 항목이 없으면 default route를 사용하고 default도 없으면 “network unreachable”이다.

Linux에서 실제 결정을 묻는다.

```sh
ip addr
ip route
ip route get 10.20.30.40
```

`ip route get`은 목적지에 대한 route lookup 결과, 선택한 source address, outgoing interface, next hop을 보여 준다. 여러 NIC와 policy routing이 있는 호스트에서는 주소만 보고 경로를 추측하는 것보다 정확하다.

## 다음 홉과 링크 계층

목적지가 같은 링크에 있으면 호스트는 ARP(IPv4)나 Neighbor Discovery(IPv6)로 목적지의 link-layer 주소를 찾는다. 다른 네트워크면 default gateway의 link-layer 주소를 찾아 프레임을 보낸다. 프레임의 목적지는 매 홉 바뀌지만 IP 목적지 주소는 일반적인 라우팅 동안 유지된다.

이 챕터는 스위칭과 VLAN을 깊게 다루지 않는다. 중요한 경계는 “IP route가 있어도 다음 홉의 link-layer 주소를 풀지 못하면 첫 패킷이 나가지 못한다”는 점이다. `ip neigh`의 `FAILED`나 `INCOMPLETE` 상태는 원격 서버보다 로컬 링크 가설을 먼저 보게 한다.

## NAT — 주소 변환은 상태를 만든다

IPv4의 source NAT는 내부 주소·포트를 외부 주소·포트로 바꾸고 역방향 패킷을 되돌리기 위한 mapping을 유지한다.

```text
10.0.0.12:53124 ──NAT── 203.0.113.7:40001 → 198.51.100.9:443
```

이 장치는 단순 라우터와 달리 흐름별 상태를 가진다. mapping의 idle timeout, 사용 가능한 port 수, 비대칭 경로가 새 실패 조건이 된다. 장시간 유휴 연결이 중간 NAT에서 사라지면 양 끝은 연결이 살아 있다고 생각하다 다음 쓰기에서야 실패를 발견할 수 있다. TCP keepalive나 애플리케이션 heartbeat는 이 상태 만료를 탐지·방지하는 선택이며 주기적 트래픽과 배터리·서버 부하를 지불한다.

IPv6는 넓은 주소 공간 덕분에 전형적인 주소 부족형 NAT 의존을 줄이지만 방화벽과 보안 정책을 없애지는 않는다. “공인 주소가 있다”와 “외부에서 접근 가능하다”는 다른 명제다.

## 이중 스택과 Happy Eyeballs

클라이언트가 A와 AAAA를 모두 얻으면 어느 주소를 먼저 시도할지 결정해야 한다. IPv6가 설정됐지만 실제 경로가 깨진 환경에서 IPv6 timeout 뒤 IPv4를 순차 시도하면 사용자 지연이 커진다. Happy Eyeballs는 주소 조회와 연결 시도를 적절히 겹쳐 한 주소 계열의 장애가 전체 연결을 오래 막지 않게 한다.

따라서 “내 `curl -4`는 빠르다”는 것은 일반 브라우저 경로의 증거가 아니다. `curl -4`, `curl -6`, 기본 동작을 각각 비교하고 실제 `remote_ip`를 기록해야 한다.

## MTU와 PMTUD — 작은 패킷 성공의 함정

Maximum Transmission Unit(MTU)은 한 링크가 fragmentation 없이 운반하는 IP packet 크기다. 경로의 최소 MTU보다 큰 패킷은 나눠지거나 버려져야 한다. IPv6 router는 fragmentation하지 않고, 송신자가 ICMPv6 Packet Too Big 메시지를 받아 크기를 낮춘다. 이 피드백을 이용하는 것이 Path MTU Discovery(PMTUD)다.

중간 방화벽이 필요한 ICMP를 막으면 작은 handshake는 성공하지만 큰 TLS record나 응답에서 연결이 멈추는 **PMTU black hole**이 생긴다. `ping` 성공만으로 애플리케이션 경로가 정상이라고 결론 내릴 수 없는 대표 사례다.

```sh
tracepath api.example.com
ping -M do -s 1472 api.example.com   # IPv4, Ethernet MTU 1500 가정의 탐색 예
```

1472는 보편적 정답이 아니다. IPv4 header 20바이트와 ICMP header 8바이트를 뺀 예일 뿐이며 option, tunnel, IPv6 여부가 바뀌면 값도 바뀐다. `tracepath`의 추정과 실제 애플리케이션 캡처를 함께 본다.

## `traceroute`가 경로를 그리는 방식과 한계

IP의 TTL/Hop Limit은 router를 하나 지날 때마다 감소한다. 0이 되면 router가 ICMP Time Exceeded를 보내고, `traceroute`는 처음부터 제한값을 1, 2, 3으로 늘려 각 홉을 추정한다.

그러나 별표는 반드시 패킷 전달 실패가 아니다. router가 ICMP 생성을 제한하거나 응답하지 않으면서 transit packet은 전달할 수 있다. ECMP 때문에 probe마다 다른 경로를 타고, 반환 경로도 정방향과 다를 수 있다. `traceroute`는 제어 평면의 probe에 응답한 홉 목록이지 데이터 패킷의 완전한 지도나 홉별 지연 합계가 아니다.

## 실무 진단 순서

1. 실제 클라이언트가 선택한 resolver, A/AAAA 답, remote IP를 기록한다.
2. `ip route get`으로 source address, interface, next hop을 확인한다.
3. 작은 연결과 큰 전송이 갈리면 MTU/PMTUD 가설을 올린다.
4. 단일 `dig`, `ping`, `traceroute`가 아니라 반복 분포와 애플리케이션 timing을 대응시킨다.
5. NAT·방화벽·로드 밸런서처럼 상태를 가진 중간 장치의 idle timeout과 경로 비대칭을 확인한다.

## 더 깊이: DNS 변경은 배포 원자성이 아니다

TTL을 낮추고 주소를 바꿔도 모든 클라이언트가 같은 순간 새 주소를 쓰지 않는다. resolver cache, 애플리케이션 내부 cache, 이미 열린 연결이 서로 다른 수명을 가진다. 안전한 전환은 구·신 endpoint가 겹쳐 서비스되는 기간을 두고, 새 주소의 관측이 충분히 늘어난 뒤 구 endpoint를 제거한다. DNS는 분산 캐시를 통한 수렴 메커니즘이지 전역 원자적 switch가 아니다.

## 정리

- DNS는 위임과 캐시로 이름을 주소로 바꾸며 TTL은 전환 속도와 부하의 trade-off다.
- 라우팅은 목적지에 가장 길게 일치하는 prefix로 다음 홉과 source address를 고른다.
- NAT는 flow 상태와 timeout이라는 새 실패 조건을 만든다.
- 이중 스택에서는 실제 선택된 주소 계열을 확인하고, 작은 패킷만 성공하면 MTU/PMTUD를 의심한다.
- `dig`, `traceroute`, `ping`은 각각 일부 경계만 관찰하므로 한 도구로 end-to-end 성공을 증명할 수 없다.

## 확인 문제

1. 배포 뒤 일부 사용자만 10분간 NXDOMAIN을 받는다. 새 record의 TTL만 확인하면 부족한 이유는 무엇인가?
2. `ping`과 TCP handshake는 성공하지만 큰 HTTPS 응답이 멈춘다. 가능한 원인과 최소 대조 실험을 제시하라.
3. `traceroute`의 중간 홉 하나가 `*`지만 최종 목적지는 응답한다. 이 결과를 어떻게 해석해야 하는가?

<details>
<summary>정답과 해설</summary>

1. 존재하지 않았다는 답도 SOA 정책에 따라 negative cache된다. recursive·애플리케이션 cache와 이미 열린 연결의 수명도 별도다.
2. PMTU black hole 가설이 가능하다. DF를 유지한 probe 크기를 낮춰 경계값을 찾고, `tracepath`와 캡처에서 ICMP Packet Too Big/Fragmentation Needed 또는 반복 재전송을 확인한다.
3. 해당 router가 ICMP 응답을 생략·제한했을 수 있다. transit packet 전달 실패의 증거가 아니며 최종 응답은 end-to-end 전달이 됐음을 보여 준다.

</details>

## 참고 자료

- [RFC 1034 — Domain Names: Concepts and Facilities](https://www.rfc-editor.org/rfc/rfc1034.html): DNS namespace, 위임, resolver 모델을 정의한다.
- [RFC 1035 — Domain Names: Implementation and Specification](https://www.rfc-editor.org/rfc/rfc1035.html): DNS message와 record의 구현 규칙을 정의한다.
- [RFC 2308 — Negative Caching of DNS Queries](https://www.rfc-editor.org/rfc/rfc2308.html): NXDOMAIN과 부재 응답의 cache 규칙을 설명한다.
- [RFC 8305 — Happy Eyeballs Version 2](https://www.rfc-editor.org/rfc/rfc8305.html): 이중 스택에서 주소 해석과 연결 경주 알고리즘을 정의한다.
- [RFC 8200 — IPv6 Specification](https://www.rfc-editor.org/rfc/rfc8200.html), [RFC 8201 — Path MTU Discovery for IPv6](https://www.rfc-editor.org/rfc/rfc8201.html): IPv6 전달과 PMTUD의 기준이다.
- [ip-route(8)](https://man7.org/linux/man-pages/man8/ip-route.8.html): Linux route lookup 관찰 명령의 공식 매뉴얼이다.
