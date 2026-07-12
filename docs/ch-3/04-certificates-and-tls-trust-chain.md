# 3.4 인증서와 TLS 신뢰 사슬 — 공개키를 이름에 묶는다

> 인증서는 암호화를 수행하는 열쇠가 아니라 이름과 공개키를 CA 서명으로 묶은 문서다. TLS는 이 바인딩 위에 ECDHE·HKDF·AEAD를 조립한다.

## 학습 목표

- X.509 인증서의 SAN·issuer·유효기간·key usage가 검증에 쓰이는 과정을 설명한다.
- leaf에서 intermediate와 trust anchor로 이어지는 서명 경로를 추적한다.
- 만료·이름 불일치·중간 인증서 누락·알 수 없는 CA를 서로 다른 실패로 진단한다.
- TLS 1.3 협상 결과를 key exchange group, signature scheme, AEAD, HKDF hash로 분해한다.
- HTTPS의 기밀성·무결성·서버 인증 계약과 그 밖의 신뢰를 구분한다.

## 배경: MITM이 내민 공개키도 수학적으로는 정상이다

[3.3](./03-asymmetric-crypto-and-key-exchange.md)의 인증되지 않은 Diffie–Hellman에서 중간자는 양쪽과 각각 정상적인 shared secret을 만든다. 암호 수학은 성공했지만 "이 key가 `api.example.com`의 것"이라는 명제가 없었다.

public key fingerprint를 안전한 별도 채널로 직접 비교할 수 있다면 문제를 풀 수 있다. 하지만 처음 방문하는 수십억 웹 연결마다 사람이 비교할 수는 없다. Public Key Infrastructure(PKI)는 신뢰한 인증 기관(Certificate Authority, CA)이 이름과 public key의 관계에 서명하고, client가 소수의 root CA 집합을 미리 배포받는 방식으로 이 규모 문제를 푼다.

## 핵심 개념

### X.509 인증서는 서명된 key 바인딩이다

웹의 X.509 인증서에는 대략 다음 정보가 들어 있다.

| 필드 | 질문 | 검증에서의 역할 |
|---|---|---|
| Subject Alternative Name(SAN) | 어느 DNS 이름·IP를 나타내는가 | 요청한 서비스 identity와 대조한다 |
| Subject | 인증서 주체의 이름은 무엇인가 | 표시·식별 정보이며 현대 DNS 이름 검증은 SAN을 사용한다 |
| Subject Public Key Info | 어떤 public key와 알고리즘인가 | handshake signature 검증에 사용한다 |
| Issuer | 누가 발급했다고 주장하는가 | 상위 인증서 후보를 찾는 단서다 |
| Validity | 언제부터 언제까지 유효한가 | client 시각이 범위 안인지 확인한다 |
| Key Usage / Extended Key Usage | key를 어디에 써도 되는가 | digital signature, server authentication 등 용도를 제한한다 |
| Basic Constraints | CA인가, 경로 길이는 얼마인가 | leaf가 임의 인증서를 발급하지 못하게 한다 |
| Signature | 발급자가 위 필드에 동의했는가 | issuer public key로 검증한다 |

인증서는 secret을 포함하지 않는다. 서버는 인증서에 든 public key에 대응하는 private key를 별도로 보관하고, TLS `CertificateVerify`에서 handshake transcript에 서명해 실제 소유를 증명한다.

현대 TLS 서비스 identity 검증은 DNS 이름을 SAN의 `dNSName`과 비교한다. legacy Common Name(CN) fallback에 기대지 않는다. wildcard `*.example.com`은 일반적으로 `a.example.com` 한 label에는 맞지만 `a.b.example.com`이나 bare `example.com`에는 맞지 않는다. IP 주소로 접속해 검증하려면 적절한 `iPAddress` SAN이 필요하다.

### 신뢰 사슬은 서명을 위로 검증한다

전형적인 경로는 다음과 같다.

```text
leaf: api.example.com
  signed by Intermediate CA private key
       │
       ▼
intermediate CA certificate
  signed by Root CA private key
       │
       ▼
root CA = client trust store의 trust anchor
```

서버는 보통 leaf와 필요한 intermediate를 보낸다. root는 이미 client trust store에 있고 보내더라도 그 자체로 신뢰가 생기지 않으므로 보통 생략한다. client는 가능한 certification path를 만들고 각 서명, CA basic constraints, key usage, 이름 제약, 정책, 유효기간을 검사해 로컬 trust anchor에 도달해야 한다.

root 인증서는 대개 self-signed지만 **self-signature가 root를 신뢰하게 만들지는 않는다**. OS·브라우저·런타임 배포 정책이 해당 root를 trust anchor로 지정했기 때문에 신뢰한다. 수학은 "이 서명은 이 key로 만들어졌다"를 검증할 뿐 "이 CA를 사회적으로 믿어도 된다"를 결정하지 않는다.

### 이름 검증과 경로 검증은 별도 단계다

서명 경로가 유효해도 요청한 이름과 leaf SAN이 다르면 연결은 실패해야 한다. 반대로 SAN이 정확해도 issuer를 신뢰하지 않으면 실패한다.

```text
1. 서버가 private key를 소유하는가?          CertificateVerify
2. leaf에서 trust anchor까지 유효한 경로인가? path validation
3. 현재 시각이 각 인증서 유효기간 안인가?     validity
4. 요청한 service identity가 SAN과 일치하는가? identity verification
5. 정책상 폐기·용도 제한에 걸리지 않는가?     revocation / usage / policy
```

이 구분은 장애 진단에 중요하다. 브라우저 화면의 "certificate error" 하나를 보고 재발급부터 하지 말고, 제공 chain, local trust store, client 시각, 접속 hostname, SNI를 각각 수집한다.

### 폐기는 만료보다 어려운 분산 상태 문제다

private key가 유출되거나 인증서가 잘못 발급되면 만료 전에 폐기해야 한다. Certificate Revocation List(CRL)은 CA가 폐기 목록을 게시하고, Online Certificate Status Protocol(OCSP)은 특정 인증서 상태를 질의한다. 둘 다 network 실패, privacy, cache freshness, 응답 가용성이라는 비용이 있다.

브라우저와 플랫폼은 OCSP stapling, vendor가 배포하는 blocklist·압축된 revocation set, 수명이 짧은 인증서 등 여러 정책을 조합한다. "OCSP 서버에 연결하지 못하면 항상 차단한다"처럼 모든 client에 통용되는 단일 동작을 가정하지 않는다. 운영자는 자동 갱신과 key rotation을 기본으로 하고, 폐기 전파 특성은 사용하는 client·root program 정책으로 확인한다.

### TLS 1.3은 네 종류의 선택을 독립적으로 협상한다

TLS 1.2까지의 긴 cipher suite 이름에 익숙하면 TLS 1.3의 `TLS_AES_128_GCM_SHA256`에 key exchange와 signature가 없다는 점이 낯설다. TLS 1.3은 다음 선택을 분리한다.

| 협상 요소 | 예 | 앞 문서의 프리미티브 | 역할 |
|---|---|---|---|
| cipher suite | `TLS_AES_128_GCM_SHA256` | AES-GCM + SHA-256/HKDF | record AEAD와 key schedule hash |
| supported group / key share | X25519, P-256 | ECDHE | ephemeral shared secret 합의 |
| signature scheme | RSA-PSS, ECDSA, Ed25519 | 디지털 서명 | `CertificateVerify`로 transcript 인증 |
| certificate chain | leaf → intermediate | X.509/CA | signature public key를 DNS 이름에 연결 |

따라서 "cipher가 AES-128이니 RSA key exchange"처럼 이름을 역추론하면 안 된다. capture나 API에서 protocol version, cipher suite, negotiated group, peer certificate key, CertificateVerify signature scheme을 각각 확인한다.

단순화한 full handshake는 다음과 같다.

```text
client                                             server
ClientHello
  versions, cipher suites, key_share,
  signature algorithms, SNI  -------------------->
                                      ServerHello, key_share
                              {EncryptedExtensions}
                              {Certificate chain}
                              {CertificateVerify}
                              {Finished} <----------
{Finished} --------------------------------------->
application data <========== AEAD records ========>
```

1. ClientHello와 ServerHello의 key shares가 ECDHE shared secret을 만든다.
2. HKDF가 shared secret과 handshake transcript에서 단계별 traffic secret을 유도한다.
3. 인증서 chain이 서버 장기 signature public key를 요청 hostname에 묶는다.
4. CertificateVerify가 지금 handshake transcript에 대한 private-key signature를 제공한다.
5. Finished MAC이 transcript와 derived key를 결합해 key confirmation과 handshake integrity를 제공한다.
6. application data는 선택된 AEAD로 기밀성과 무결성을 얻는다.

TLS handshake의 RTT, session resumption, 0-RTT replay와 QUIC 통합은 [9.4 TLS·QUIC·HTTP/3](../ch-9/04-tls-quic-and-http3.md)의 전송·성능 관점에 위임한다. 여기서는 full handshake에서 암호 계약이 어떻게 연결되는지에 집중한다.

### HTTPS가 보장하는 것과 보장하지 않는 것

올바르게 검증된 HTTPS 연결은 client와 TLS terminator 사이에서 다음을 제공한다.

- application data의 기밀성
- 전송 중 능동 변조에 대한 무결성
- 요청한 service identity에 대한 서버 인증(일반적인 server-auth TLS)

그러나 다음을 자동으로 보장하지 않는다.

- 서버 운영자가 선의인지, 응답 내용이 사실인지, malware가 없는지
- TLS terminator 뒤 proxy–origin 구간도 같은 방식으로 보호되는지
- endpoint가 plaintext를 안전하게 저장하고 권한을 올바르게 검사하는지
- IP 주소, 연결 시각, 패킷 크기와 traffic pattern 같은 모든 metadata가 숨겨지는지
- client identity가 인증됐는지. 일반 HTTPS는 보통 서버만 인증한다.

"HTTPS 사이트"는 전송 채널에 관한 판단이지 사업자나 콘텐츠의 신뢰도 평가가 아니다.

## 실패 모드: 에러가 포기하라는 계약을 읽는다

| 현상 | 가능한 원인 | 먼저 볼 증거 |
|---|---|---|
| expired / not yet valid | 갱신 실패, 잘못된 client 시각 | leaf·intermediate validity와 시스템 시각 |
| hostname mismatch | 잘못된 SAN, IP로 접속, SNI/가상호스트 오류 | 요청 hostname, SAN, SNI |
| unable to get local issuer | intermediate 누락, 알 수 없는 CA | 서버 제공 chain과 client trust store |
| self-signed certificate | trust anchor로 등록되지 않은 자체 서명 leaf | fingerprint와 명시적 trust 설정 |
| bad certificate / key usage | 용도·알고리즘 정책 불일치 | KU/EKU, signature scheme, client 정책 |

`curl -k` 또는 Node의 `rejectUnauthorized: false`는 "자체 서명만 허용"하는 옵션이 아니다. path와 hostname 검증 실패를 무시해 공격자의 인증서도 받아들일 수 있다. 암호화 자체는 계속될 수 있지만 상대 신원을 확인하지 못하므로 MITM에 안전한 channel이라는 핵심 계약을 포기한다.

개발 환경의 자체 CA를 신뢰해야 한다면 CA 인증서를 해당 test client의 별도 trust store에 명시적으로 추가한다. 전역 검증 비활성화보다 신뢰 범위를 좁히고 production 설정과 섞이지 않게 한다.

## 미니 실험: chain을 읽고 자체 서명 실패를 재현한다

### 공개 사이트의 chain 추적

```sh
openssl s_client \
  -connect example.com:443 \
  -servername example.com \
  -showcerts </dev/null
```

`Certificate chain`의 각 인증서에서 subject와 issuer를 잇고 마지막 `Verify return code`를 기록한다. OpenSSL 버전과 trust store에 따라 구성 경로가 달라질 수 있다. 서버 출력에 root가 없다는 사실은 정상일 수 있다.

TLS 1.3의 분리된 협상 값은 다음 명령과 packet analyzer에서 확인한다.

```sh
openssl s_client \
  -connect example.com:443 \
  -servername example.com \
  -tls1_3 -brief </dev/null
```

`Protocol version`, `Ciphersuite`, `Peer certificate`, `Signature type`, `Negotiated TLS1.3 group`을 기록한다. OpenSSL 빌드에 따라 필드 이름과 제공 정보가 다르므로 `openssl version -a`도 남긴다.

### 로컬 자체 서명 서버

학습용 key와 certificate를 만들고 Node TLS echo server를 실행한다. 생성 파일을 repository에 commit하지 않는다.

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 1 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost'
```

```js
// self-signed-server.mjs
import { readFileSync } from "node:fs";
import { createServer, connect } from "node:tls";

const cert = readFileSync("localhost-cert.pem");
const server = createServer({
  key: readFileSync("localhost-key.pem"),
  cert,
}, (socket) => socket.end("authenticated channel\n"));

server.listen(8443, "127.0.0.1", () => {
  const rejected = connect({ host: "127.0.0.1", servername: "localhost", port: 8443 }, () => {
    console.log("unexpected success");
  });
  rejected.on("error", (error) => {
    console.log("default trust:", error.code);

    const trusted = connect({
      host: "127.0.0.1",
      servername: "localhost",
      port: 8443,
      ca: cert,
    }, () => {
      console.log("explicit CA:", trusted.authorized);
      trusted.end();
      server.close();
    });
    trusted.on("error", console.error);
  });
});
```

기본 연결은 trust anchor가 없어 실패하고, 같은 인증서를 이 client의 `ca`로 명시한 연결은 이름과 서명을 검증해 성공한다. `rejectUnauthorized: false`를 쓰지 않고 **무엇을 신뢰하는지 추가**했다는 차이가 핵심이다. 연결 코드의 callback과 error 순서는 런타임·네트워크 조건에 따라 달라질 수 있으므로 종료되지 않으면 socket error와 server close 처리를 보강한다.

## 실무 관점: 신뢰 사슬의 변형

### 사내 CA

조직이 root 또는 intermediate CA를 운영하고 관리 기기에 trust anchor를 배포한다. 공개 Web PKI와 같은 path validation 모델이지만 발급 정책, root 보호, 폐기, device onboarding 책임을 조직이 맡는다. 내부 DNS라는 이유만으로 이름 검증을 끄지 않는다.

### mutual TLS

mTLS에서는 서버도 client certificate를 요청하고 별도의 client CA·identity mapping 정책으로 검증한다. certificate가 유효하다는 사실과 애플리케이션 권한은 분리한다. SAN이나 확장 identity를 계정·service principal에 안전하게 매핑한 뒤 authorization을 수행해야 한다.

### certificate pinning

pinning은 특정 public key나 CA 집합으로 신뢰 범위를 줄일 수 있지만 rotation·재발급·비상 교체가 막히는 가용성 비용이 크다. 브라우저 Web PKI를 대체하려는 일반 웹 앱보다 업데이트 채널을 통제하는 native client에서 backup pin과 원격 복구 계획을 갖춰 신중하게 사용한다.

### ACME 자동화

ACME는 domain control 검증과 발급·갱신 절차를 자동화한다. 자동화가 CA의 신뢰 모델을 없애는 것은 아니다. 짧은 인증서 수명과 자동 갱신은 장기 key·수동 작업의 노출 기간을 줄이지만, 갱신 job 모니터링, challenge 권한, 배포 원자성, 만료 경보가 새 운영 계약이 된다.

## 더 깊이: 신뢰의 뿌리는 제도다

root program은 CA의 인증 업무 준칙, 감사, 사고 보고, 기술 제약을 정책으로 관리한다. CA가 잘못된 이름에 인증서를 발급하면 서명 수학은 완벽히 통과하면서 신원 바인딩이 거짓일 수 있다. 과거 DigiNotar 사건처럼 광범위한 오발급·침해는 root 퇴출과 client update로 대응했다.

Certificate Transparency(CT)는 공개 log에 인증서를 기록해 domain owner와 생태계가 오발급을 발견할 수 있게 한다. CT는 발급 전에 모든 잘못을 막는 authorization 체계가 아니라 탐지와 책임 추적을 강화한다. 신뢰 사슬은 절대적 진리가 아니라 감사 가능한 기관, 제한된 권한, 짧은 수명, 공개 log, client 정책으로 위험을 관리하는 시스템이다.

## 정리

- X.509 인증서는 service identity와 public key를 issuer 서명으로 묶는다. private key나 session key를 담지 않는다.
- path validation, 유효기간, SAN 이름 검증, key usage와 폐기는 서로 다른 검사다.
- root는 self-signed라서가 아니라 client trust store 정책에 들어 있어 신뢰된다.
- TLS 1.3 cipher suite는 AEAD와 HKDF hash를 정하고, ECDHE group과 signature scheme은 별도로 협상한다.
- HTTPS는 channel의 기밀성·무결성·서버 identity를 보장하지만 서버의 선의와 모든 metadata 은닉을 보장하지 않는다.

## 확인 문제

**1.** 브라우저 A는 성공하고 새 컨테이너의 Node client만 `unable to get local issuer certificate`로 실패한다. 경쟁 가설과 확인 순서를 제시하라.

::: details 정답과 해설
서버가 intermediate를 누락했고 브라우저는 cache나 별도 경로 구성으로 보완했을 수 있다. 또는 두 client의 trust store가 다를 수 있다. `openssl s_client -showcerts`로 서버 제공 chain을 확인하고 leaf issuer에 대응하는 intermediate가 있는지, 각 client trust store가 같은 root를 갖는지 비교한다. 검증을 끄는 것은 진단이 아니다.
:::

**2.** `TLS_AES_256_GCM_SHA384`만 보고 서버 인증서가 RSA인지 ECDSA인지, key exchange가 X25519인지 알 수 있는가?

::: details 정답과 해설
알 수 없다. TLS 1.3 cipher suite는 record AEAD와 HKDF hash만 나타낸다. supported group/key share와 CertificateVerify signature scheme, peer certificate key를 각각 확인해야 한다.
:::

**3.** 자체 서명 인증서를 쓰기 위해 `rejectUnauthorized: false`를 켜자는 제안과 해당 인증서를 client `ca`에 추가하는 방식의 차이를 설명하라.

::: details 정답과 해설
전자는 path와 이름 검증 실패를 전반적으로 허용해 어떤 공격자 인증서도 받을 수 있다. 후자는 명시한 trust anchor로 서명 경로와 hostname을 계속 검증해 신뢰 범위를 특정 인증서 또는 CA로 제한한다.
:::

**4.** 유효한 HTTPS를 쓰는 phishing 사이트가 가능한 이유는 무엇인가?

::: details 정답과 해설
인증서는 요청한 domain과 public key의 관계를 보증한다. 그 domain 운영자의 선의, 브랜드와의 유사성, 콘텐츠 안전성을 보증하지 않는다. 사용자가 공격자의 실제 domain에 접속했다면 TLS는 그 공격자 domain과의 channel을 정확히 보호할 수 있다.
:::

## 참고 자료

- [RFC 5280 — Internet X.509 PKI](https://www.rfc-editor.org/rfc/rfc5280.html): 인증서 필드와 certification path validation의 기준이다.
- [RFC 9525 — Service Identity in TLS](https://www.rfc-editor.org/rfc/rfc9525.html): SAN 기반 service identity와 이름 검증 규칙을 정의하고 legacy CN-ID를 제외한다.
- [RFC 8446 — TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html): handshake, 독립적인 암호 협상, HKDF key schedule과 Finished를 정의한다.
- [CA/Browser Forum Baseline Requirements](https://cabforum.org/working-groups/server/baseline-requirements/requirements/): 공개 TLS 인증서 발급·검증 기관의 운영 기준을 제공한다.
- [Certificate Transparency](https://certificate.transparency.dev/): 공개 인증서 log의 탐지 모델과 생태계를 설명한다.
- [Node.js TLS 문서](https://nodejs.org/api/tls.html): `ca`, `rejectUnauthorized`, peer certificate 검증 동작의 API 기준이다.
- [OpenSSL s_client 문서](https://docs.openssl.org/master/man1/openssl-s_client/): chain·협상 결과 관찰 명령의 기준이다.
