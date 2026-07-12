# 챕터 3 실습 — 엔트로피 한계와 TLS 신뢰 사슬을 증거로 확인하기

[ROADMAP](../../ROADMAP.md) 챕터 3의 산출물인 **허프만 압축기와 TLS handshake 분석 리포트**를 작성한다. [챕터 3 기획](../../plan/ch-3.md)과 [본문 4편](../../docs/ch-3/00-introduction.md)을 전제로 한다.

Part A는 "입력 모델이 압축 하한을 정한다"를 구현과 수치로 검증한다. Part B는 "TLS가 하나의 암호가 아니라 key agreement·signature·trust chain·KDF·AEAD의 조립"임을 packet과 certificate에서 확인한다. 두 Part 모두 실행 성공만이 아니라 예측, 관찰, 반증, 한계를 리포트로 남겨야 완료된다.

## 학습 목표

- 바이트 빈도에서 엔트로피를 계산하고 허프만 평균 부호 길이와 비교한다.
- prefix code를 binary format으로 직렬화해 임의 byte sequence를 무손실 왕복한다.
- payload 절약분과 header overhead를 분리해 실제 압축률을 해석한다.
- TLS 1.3의 cipher suite, key exchange group, signature scheme, certificate chain을 각각 식별한다.
- 자체 서명 인증서의 실패와 검증 비활성화의 차이를 신뢰 계약으로 설명한다.

## 기준 환경과 안전

기준 환경은 macOS와 Node.js 24다. Part A는 별도 runtime dependency 없이 TypeScript, `node:test`, Node.js 표준 모듈만 사용한다. 저장소 root의 `mise.toml`과 `package.json`에 지정된 Node·pnpm을 사용한다.

Part B에는 다음 도구가 필요하다.

- OpenSSL 3 계열의 `openssl s_client`
- TLS 1.3을 지원하고 key log를 내보낼 수 있는 `curl`
- `tshark`와 `dumpcap` 또는 Wireshark

시작 전에 실제 build feature를 기록한다.

```sh
node --version
pnpm --version
openssl version -a
curl --version
tshark --version
```

macOS 기본 도구와 package manager로 설치한 도구는 TLS backend와 지원 option이 다를 수 있다. `SSLKEYLOGFILE`을 설정한 시험 요청 뒤 파일이 비어 있다면 해당 curl build가 key logging을 지원하는지 확인하고, 지원되는 OpenSSL 기반 curl을 사용한다. 실습 도구의 버전을 리포트에 반드시 기록한다.

패킷 캡처는 본인 소유의 장비와 허가된 실습 traffic에만 수행한다. TLS key log는 캡처된 session의 application data를 복호화하는 민감 정보다. 다음 파일은 `.gitignore`에 개인 작업 규칙으로 추가하거나 저장소 밖 임시 디렉터리에 두고 절대 commit하지 않는다.

- private key와 자체 서명 인증서
- `*.pcap`, `*.pcapng`, `*.keys`, `SSLKEYLOGFILE`
- 복호화된 HTTP header·cookie·authorization 값
- 실험용 입력 중 민감한 실제 데이터

## 권장 산출물 구조

구현 파일명은 바꿀 수 있지만 책임 경계는 유지한다.

```text
exercises/ch-3/
├── README.md                 # 이 과제 명세
├── package.json
├── tsconfig.json
├── src/
│   ├── entropy.ts            # byte frequency, entropy, metrics
│   ├── huffman.ts            # tree, code lengths, encode/decode
│   ├── format.ts             # binary header serialization
│   └── cli.ts                # compress/decompress/analyze
├── test/
│   ├── huffman.test.ts
│   └── format.test.ts
├── fixtures/                 # 생성 가능한 비민감 fixture만
└── report.md                 # 두 Part의 예측·결과·분석
```

solution source를 제출할 때 생성물(`dist/`, capture, key log, private key)은 제외한다. 공개 사이트의 현재 인증서·협상 값은 바뀔 수 있으므로 값 자체를 fixture로 고정하지 않는다.

---

## Part A — 허프만 압축기

### A1. byte frequency와 엔트로피

`Buffer`의 0~255 각 byte 빈도를 센다. byte `i`의 확률을 `pᵢ=countᵢ/N`이라 할 때 다음 지표를 계산한다.

```text
H = -Σ pᵢ log₂ pᵢ                 bits/byte
entropy lower bound = H × N       bits
```

빈 입력은 확률 분포가 없으므로 이 실습에서는 entropy를 0으로 정의한다. 이 선택을 코드와 test에 명시한다. 문자열 character 빈도가 아니라 **인코딩이 끝난 byte 빈도**를 센다. 입력 문자열의 Unicode code point와 UTF-8 byte를 혼동하지 않는다.

### A2. 허프만 tree와 canonical code

다음 단계를 구현한다.

1. 빈도가 0보다 큰 byte마다 leaf node를 만든다.
2. 최소 빈도 node 두 개를 꺼내 parent로 합치고 다시 넣는다.
3. root에서 leaf까지 경로로 code length를 구한다.
4. 같은 길이에서 byte 값 순으로 정렬해 canonical Huffman code를 만든다.
5. 입력 byte를 code bit sequence로 encode하고 원래 길이만큼 decode한다.

빈도가 같은 node의 우선순위는 deterministic해야 test와 파일 재현성이 생긴다. `frequency → 최소 포함 byte → insertion order`처럼 tie-break 규칙을 문서화한다.

canonical code를 권장하는 이유는 tree 전체 대신 각 byte의 code length만 저장해 decoder가 같은 code table을 재구성할 수 있기 때문이다. 직접 tree를 직렬화해도 되지만 header 크기와 deterministic reconstruction을 동일하게 증명해야 한다.

단일 symbol 입력에서는 경로 길이가 0이 될 수 있다. 이 과제에서는 해당 symbol에 1비트 code를 할당하거나, 원본 길이와 symbol 하나만으로 payload 없이 복원하는 format을 선택한다. 어느 쪽이든 빈 입력과 구분되고 round trip이 완결되어야 한다.

### A3. binary format

최소한 다음 정보를 한 파일에 저장한다.

- format magic과 version
- 원본 byte length
- payload의 유효 bit length 또는 마지막 byte padding 수
- 사용한 symbol과 code length 또는 동등한 tree 정보
- packed payload bits

multi-byte integer의 byte order와 최대 입력 크기를 정한다. parser는 다음 잘못된 입력을 명시적으로 거부해야 한다.

- 잘못된 magic/version
- 중복 symbol 또는 불가능한 code length 집합
- header보다 짧게 잘린 파일
- 선언된 원본 길이와 맞지 않는 decode 결과
- payload가 끝났는데 code가 leaf에 도달하지 않은 경우
- 합리적 한도를 넘는 길이로 memory allocation을 유도하는 경우

toy compressor라도 untrusted file parser라는 사실은 같다. parse error를 무한 loop나 process crash와 구분 가능한 error로 반환한다.

### A4. bit packing

`"0101..."` 문자열은 관찰용으로는 편하지만 실제 압축 크기를 재지 못한다. 8개의 code bit를 한 output byte에 pack한다. 마지막 byte의 남는 bit와 유효 길이를 header로 복원한다.

필수 함수의 예시는 다음과 같다. 이름은 바꿀 수 있다.

```ts
export function entropyBitsPerByte(input: Uint8Array): number;
export function buildCodeLengths(frequencies: readonly number[]): Uint8Array;
export function encode(input: Uint8Array, lengths: Uint8Array): EncodedBits;
export function decode(bits: EncodedBits, lengths: Uint8Array, originalLength: number): Uint8Array;
export function compress(input: Uint8Array): Uint8Array;
export function decompress(archive: Uint8Array): Uint8Array;
```

### A5. CLI와 공통 report

다음 동작을 한 명령으로 재현할 수 있게 한다.

```sh
pnpm analyze
pnpm test
pnpm exec tsx src/cli.ts compress input.bin output.huf
pnpm exec tsx src/cli.ts decompress output.huf restored.bin
```

`tsx`를 dependency로 추가하고 싶지 않으면 TypeScript compiler로 build한 JavaScript를 `node`로 실행한다. "별도 runtime dependency 없음"은 압축 알고리즘이 외부 package에 의존하지 않는다는 뜻이며, 개발 도구는 root의 TypeScript를 재사용해도 된다.

`analyze`는 최소 다음 열을 출력한다.

| scenario | input bytes | H (bits/B) | H×N (bytes) | Huffman avg (bits/B) | payload bytes | archive bytes | gzip bytes |
|---|---:|---:|---:|---:|---:|---:|---:|

추가로 `payload/input`, `archive/input`, `gzip/input`, header bytes를 출력한다. 빈 입력의 ratio는 0으로 나누지 말고 `N/A`로 표시한다.

### A6. 검증 scenario

#### 왕복 무손실

`node:test`로 다음을 모두 검증한다.

- 빈 입력
- 한 symbol만 반복되는 입력
- 모든 256 byte 값이 같은 빈도로 나오는 입력
- UTF-8 text의 byte sequence
- `0x00`, `0xff`를 포함한 임의 binary
- 길이가 byte boundary에 맞지 않는 encoded payload
- seed를 기록한 여러 random byte sequence
- archive 한 byte씩 truncate한 malformed input 일부

random test는 실패를 재현할 seed 또는 생성 input을 출력한다. `decompress(compress(input))`이 byte-for-byte 동일한지 `Buffer.equals`로 확인한다.

#### 엔트로피와 압축률

고정 seed 또는 fixture 생성기로 크기가 같은 세 입력을 만든다.

1. 자연어 또는 반복 구조가 있는 text
2. `node:crypto.randomBytes`로 만든 균등 random bytes
3. 충분히 큰 2번 또는 다양한 corpus를 `node:zlib.gzipSync`로 이미 압축한 bytes

각 입력에서 entropy, Huffman payload, header 포함 archive, gzip을 비교한다. random 결과는 실행마다 달라질 수 있으므로 report에 입력 hash와 크기를 기록한다.

#### Shannon 한계

symbol이 둘 이상인 입력의 Huffman 평균 길이 `L`에 대해 다음을 확인한다.

```text
H ≤ L < H + 1
```

유한 표본의 실수 오차 허용 범위를 test에 둔다. 이 부등식은 **payload의 평균 code length**에 관한 것이지 header 포함 archive 크기에 관한 것이 아니다. 단일 symbol·빈 입력은 선택한 format convention을 별도 설명한다.

gzip이 byte-Huffman보다 잘 줄이는 text에서 그 차이를 반복 substring과 symbol correlation으로 설명한다. 같은 byte multiset을 shuffle한 대조군을 추가하면 1차 byte entropy는 같고 gzip 결과는 달라지는 것을 확인할 수 있다.

### Part A 완료 기준

- [ ] 모든 필수·경계 입력에서 `decompress(compress(input))`이 원본과 같다.
- [ ] canonical code 또는 동등한 tree 정보를 포함한 단일 archive format을 구현했다.
- [ ] malformed archive의 길이·code table·payload 오류를 안전하게 거부한다.
- [ ] 한 명령으로 세 scenario의 공통 metrics report를 재현한다.
- [ ] payload 평균 길이와 엔트로피의 `H ≤ L < H+1` 관계를 수치로 확인했다.
- [ ] header overhead와 gzip의 더 나은 context modeling을 결과에서 분리해 설명했다.

---

## Part B — TLS handshake와 신뢰 사슬 분석

### B1. 대상 선정과 사전 조사

공개 HTTPS 사이트 두 곳 이상과 local self-signed Node TLS server를 대상으로 한다. 공개 대상은 본인 서비스 또는 일반적인 실습 요청을 허용하는 공개 웹사이트의 root page처럼 부하가 작은 endpoint를 선택한다. 자동 반복 요청이나 인증된 실제 업무 요청은 사용하지 않는다.

두 공개 대상은 가능한 한 다음 중 둘 이상이 다르게 관찰되도록 고른다.

- leaf public key type 또는 CertificateVerify signature scheme
- intermediate/root CA 경로
- negotiated ECDHE group
- TLS 1.3 cipher suite

서버 설정과 client 제안에 따라 두 사이트가 같은 값을 선택할 수 있다. 먼저 `openssl s_client -brief`로 확인하고 모두 같으면 대상을 바꾸거나, OpenSSL의 `-groups`·`-ciphersuites`로 **client 제안 하나만 통제한 별도 실험**을 추가한다. 관찰되지 않은 차이를 추측해 채우지 않는다.

대상별로 hostname, 접속 시각, IP, 도구 버전을 기록한다. CDN·load balancer 때문에 시간·지역에 따라 certificate와 협상 결과가 달라질 수 있음을 한계에 적는다.

### B2. OpenSSL로 certificate chain과 협상 값 수집

각 공개 사이트에 다음 명령을 실행한다.

```sh
host=example.com

openssl s_client \
  -connect "$host:443" \
  -servername "$host" \
  -tls1_3 -showcerts -status -prexit </dev/null
```

server가 보낸 각 certificate를 별도 PEM으로 저장하고 다음 필드를 추출한다.

```sh
openssl x509 -in leaf.pem -noout \
  -subject -issuer -serial -dates -fingerprint -sha256 \
  -ext subjectAltName -ext keyUsage -ext extendedKeyUsage -ext basicConstraints
```

다음 표를 채운다.

| 대상 | leaf SAN match | leaf key | CertificateVerify | intermediate(s) | local trust anchor | validity | verify result |
|---|---|---|---|---|---|---|---|

`-showcerts`는 **서버가 보낸 목록**이지 검증 완료된 chain 자체가 아니다. 서버가 root를 보내지 않는 것이 일반적이다. issuer/subject를 잇고 어느 local trust anchor에서 경로가 끝나는지 구분한다.

TLS 협상 표도 별도로 작성한다.

| 대상 | TLS version | cipher suite | AEAD | HKDF hash | negotiated group | signature scheme | ALPN |
|---|---|---|---|---|---|---|---|

TLS 1.3 cipher suite에서 key exchange와 signature를 읽어내지 않는다. `AES_128_GCM`은 record AEAD, `SHA256`은 HKDF/transcript hash를 나타내며 group과 signature는 별도 필드다.

### B3. packet capture와 TLS key log

먼저 packet capture interface를 식별한다. loopback은 `lo0`, 외부 traffic은 사용 중인 Wi-Fi/Ethernet interface다. 환경에 따라 `tshark -D`에서 번호를 선택한다.

터미널 1에서 최소 범위 filter로 캡처한다. `<interface>`와 `<server-ip>`를 실제 값으로 바꾼다.

```sh
sudo tshark -i <interface> \
  -f 'host <server-ip> and tcp port 443' \
  -w public-site.pcapng
```

터미널 2에서 새 key log 파일로 한 번 요청한다.

```sh
rm -f /tmp/ch3-tls.keys
SSLKEYLOGFILE=/tmp/ch3-tls.keys \
  curl --tlsv1.3 --http1.1 -sS -o /dev/null -v https://example.com/
```

`rm`은 본인이 만든 실습 임시 파일에만 사용한다. 요청 뒤 key log가 비어 있지 않은지 확인하고 캡처를 중지한다. 이 문서의 명령은 HTTP/2 stream 복잡도를 피하려 `--http1.1`을 사용하지만, ALPN 비교가 목적이면 별도 capture에서 HTTP/2를 사용해도 된다.

key log로 복호화한 handshake와 application data를 확인한다.

```sh
tshark -r public-site.pcapng \
  -o tls.keylog_file:/tmp/ch3-tls.keys \
  -Y 'tls.handshake or http' \
  -V
```

필드 이름은 tshark 버전에 따라 달라질 수 있다. `tshark -G fields | rg 'tls.*(key_share|supported_group|ciphersuite|signature)'`로 실제 field를 확인한다. 최소한 packet 번호와 시각을 다음 event에 대응시킨다.

1. ClientHello: SNI, offered version, cipher suites, supported groups/key shares, signature algorithms
2. ServerHello: selected version, cipher suite, key share group
3. encrypted handshake: Certificate, CertificateVerify, Finished
4. application data: 복호화된 HTTP request/response가 보이는지

key log 없이 같은 pcap을 열어 3~4의 payload가 보이지 않는지 대조한다. key log가 암호를 "공격해서 푼" 것이 아니라 endpoint가 session secret을 제공했기 때문에 복호화됐다는 점을 설명한다.

### B4. local self-signed 실패 재현

[3.4 미니 실험](../../docs/ch-3/04-certificates-and-tls-trust-chain.md#미니-실험-chain을-읽고-자체-서명-실패를-재현한다)의 절차로 `localhost` SAN이 든 1일짜리 certificate와 private key를 만들고 Node TLS server를 `127.0.0.1:8443`에서 실행한다.

세 연결을 비교한다.

```sh
# 1. 기본 trust store: self-signed issuer를 신뢰하지 않아 실패해야 한다.
curl -v https://localhost:8443/

# 2. 검증 비활성화: 연결되지만 identity 계약을 포기한다.
curl -vk https://localhost:8443/

# 3. 명시적 trust anchor: 이 certificate를 신뢰하며 이름 검증은 유지한다.
curl -v --cacert localhost-cert.pem https://localhost:8443/
```

서버가 raw TLS text만 보내 HTTP 형식이 아니라면 certificate 검증 성공 뒤 curl이 HTTP parse 오류를 낼 수 있다. TLS 성공과 application protocol 성공을 구분하거나, 최소 HTTP/1.1 response를 보내는 server로 구현한다.

추가로 `https://127.0.0.1:8443/`에 `--cacert`를 사용해 접속한다. certificate SAN이 `DNS:localhost`만 포함한다면 trust path는 맞아도 IP identity mismatch로 실패해야 한다. 이 대조가 path validation과 hostname verification을 분리한다.

loopback capture도 수행한다.

```sh
sudo tshark -i lo0 -f 'tcp port 8443' -w self-signed.pcapng
```

기본 실패, `-k`, `--cacert`를 각각 새 connection으로 보내고 어느 지점까지 handshake가 진행되는지 packet과 curl error를 대응시킨다. `-k`에서도 record encryption은 일어나지만 peer identity를 믿을 근거가 사라진다는 점을 report에 쓴다.

### B5. session resumption은 식별만 한다

같은 대상에 OpenSSL session을 저장하고 재사용해 full/resumed 여부를 확인할 수 있다.

```sh
openssl s_client -connect example.com:443 -servername example.com \
  -tls1_3 -sess_out /tmp/ch3-session.pem </dev/null

openssl s_client -connect example.com:443 -servername example.com \
  -tls1_3 -sess_in /tmp/ch3-session.pem </dev/null
```

서버 정책과 ticket 수신 timing 때문에 재개되지 않을 수 있다. 성공 여부를 있는 그대로 기록하고 PSK extension 또는 OpenSSL summary로 판단한다. RTT·0-RTT·QUIC 성능 분석은 [챕터 9 실습](../ch-9/README.md)에 위임하며 여기서 반복하지 않는다.

### Part B 완료 기준

- [ ] 서로 다른 특성이 관찰되는 공개 HTTPS 대상 두 곳 이상의 환경·시각·IP를 기록했다.
- [ ] 각 대상의 leaf→intermediate→local trust anchor 경로와 SAN·validity·key usage를 추적했다.
- [ ] TLS version, AEAD/HKDF cipher suite, ECDHE group, signature scheme을 별도 필드로 식별했다.
- [ ] key log를 사용한 capture에서 handshake와 HTTP data를 복호화하고, key log 없는 관찰과 대조했다.
- [ ] 자체 서명 기본 실패, `-k`, 명시적 `--cacert`, hostname mismatch를 비교했다.
- [ ] session resumption 여부를 증거로 식별하고 성능 분석은 챕터 9 범위로 남겼다.
- [ ] 각 값이 기밀성·무결성·key agreement·server identity 중 어떤 계약을 제공하는지 설명했다.

---

## 분석 리포트 요구사항

`report.md`는 다음 순서로 작성한다.

1. **환경과 재현성**: OS, Node, pnpm, OpenSSL, curl TLS backend, tshark 버전, 명령, 대상, 시각
2. **예측**: 결과를 보기 전에 각 scenario에서 entropy·압축률·TLS 실패를 예측하고 반증 조건 작성
3. **Part A 결과**: 공통 metrics 표, round-trip/test 결과, header/payload 분해, gzip 차이
4. **Part B 결과**: certificate path 표, 협상 표, 주요 packet 번호와 handshake timeline
5. **계약 분해**: 각 primitive가 보장하는 것, 가정, 관찰된 실패 모드
6. **한계와 대안**: 표본 크기, 입력 모델, CDN 변동, client 제안, trust store·도구 버전 차이

결론은 "gzip이 더 좋았다", "TLS 1.3이었다"에서 끝내지 않는다. 다음과 같은 원인 문장으로 쓴다.

> byte-Huffman의 payload는 1차 entropy 경계에 가까웠지만 gzip은 반복 substring을 별도 symbol처럼 모델링해 더 작았다. archive 전체는 code table header 때문에 작은 입력에서 원본보다 컸다.

> `TLS_AES_128_GCM_SHA256`은 record의 AEAD와 HKDF hash를 제공했고, X25519 key share가 ephemeral shared secret을 만들었다. ECDSA CertificateVerify와 CA chain/SAN 검증이 그 ephemeral handshake를 대상 hostname에 인증했다.

## 전체 완료 기준

- [ ] Part A와 Part B의 개별 완료 기준을 모두 충족했다.
- [ ] `pnpm test`가 깨끗한 checkout에서 통과한다.
- [ ] 세 압축 scenario를 한 명령으로 재현할 수 있다.
- [ ] source·test·report만으로 다른 사람이 환경을 재구성하고 같은 판단 절차를 수행할 수 있다.
- [ ] private key, TLS key log, packet capture, 민감 header를 commit하지 않았다.
- [ ] toy compressor와 관찰용 TLS 설정을 production 권장 구현으로 표현하지 않았다.

## 참고 자료

- [RFC 1952 — GZIP file format](https://www.rfc-editor.org/rfc/rfc1952.html): Part A의 gzip 비교 포맷과 header 관찰 기준이다.
- [RFC 8446 — TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html): Part B의 handshake와 암호 협상 필드 기준이다.
- [RFC 5280 — X.509 PKI](https://www.rfc-editor.org/rfc/rfc5280.html): certificate path와 extension 해석 기준이다.
- [OpenSSL s_client](https://docs.openssl.org/master/man1/openssl-s_client/): chain·session·협상 값 수집 option을 설명한다.
- [Wireshark TLS display filter reference](https://www.wireshark.org/docs/dfref/t/tls.html): tshark 버전별 TLS field를 찾는 기준이다.
- [Node.js test runner](https://nodejs.org/api/test.html): Part A의 `node:test` test 구조와 실행 option을 설명한다.
