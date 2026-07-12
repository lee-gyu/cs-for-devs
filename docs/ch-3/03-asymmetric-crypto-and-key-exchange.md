# 3.3 비대칭 암호와 키 교환 — 공유한 비밀 없이 비밀을 만든다

> 공개키 암호는 대용량 데이터를 대신 암호화하는 도구가 아니라, 대칭 key를 합의하고 key 소유를 증명해 key 분배의 구조를 바꾼다.

## 학습 목표

- 사전 공유 key 방식의 규모 문제를 설명하고 키 교환의 위협 모델을 세운다.
- Diffie–Hellman과 X25519에서 공개 값으로 같은 shared secret을 얻는 흐름을 추적한다.
- RSA 암호화·서명, ECDHE, 대칭 암호가 하이브리드 시스템에서 맡는 책임을 구분한다.
- MAC과 디지털 서명의 검증자·key 구조 차이를 근거로 사용 사례를 선택한다.
- ephemeral key가 forward secrecy를 제공하는 조건과 MITM에 남기는 공백을 설명한다.

## 배경: 키 분배 — 대칭 key를 전달하려면 이미 안전한 채널이 필요하다

대칭 암호는 빠르지만 두 참여자가 같은 비밀 key를 가져야 한다. `n`명이 서로 독립된 pairwise key로 통신하면 필요한 key 쌍은 `n(n-1)/2`개다. 1,000명이면 499,500개다. 새 참여자 등록, 폐기, 유출 범위 추적도 함께 커진다.

더 근본적인 순환이 있다. 비밀 key를 네트워크로 보내려면 그 전송을 암호화할 다른 key가 필요하다. 공개키 암호는 모두에게 공개해도 되는 값과 소유자만 보관하는 비밀 값을 분리해 이 key 배송 구조를 바꾼다.

## 핵심 개념

### trapdoor 없는 key agreement도 가능하다

Diffie–Hellman(DH)은 공개 채널에서 비밀 key를 직접 보내지 않고 같은 값을 계산한다. 작은 정수로 구조만 보면 다음과 같다.

```text
공개: 큰 소수 p, 생성원 g
Alice 비밀: a, 공개: A = g^a mod p
Bob   비밀: b, 공개: B = g^b mod p

Alice: s = B^a mod p = g^(ab) mod p
Bob:   s = A^b mod p = g^(ab) mod p
```

도청자는 `p`, `g`, `A`, `B`를 모두 본다. 보안은 거듭제곱은 쉽지만 `A`에서 `a`를 찾는 이산로그가 적절한 group과 크기에서 계산적으로 어렵다는 가정에 기대어 있다. 여기서 "어렵다"는 수학적으로 불가능하다는 뜻이 아니라 알려진 최선의 알고리즘과 공격 자원으로 현실적인 시간 안에 풀기 어렵다는 뜻이다. 계산 비용과 문제 크기의 관계는 챕터 2의 복잡도에서 다룬다.

실제 DH에서는 임의의 작은 소수와 생성원을 고르지 않는다. 검증된 finite-field group 또는 elliptic-curve group과 표준 인코딩을 사용하고, 받은 공개 값이 유효한지 라이브러리의 고수준 API에 맡긴다.

### 타원곡선은 같은 목적을 더 작은 key로 달성한다

Elliptic-curve Diffie–Hellman(ECDH)은 유한체 위 타원곡선 점의 scalar multiplication을 한 방향 함수로 쓴다. 같은 보안 수준에서 전통적인 finite-field DH와 RSA보다 key와 메시지가 짧고 연산·대역폭 비용이 작다.

X25519는 Curve25519 위의 ECDH 함수로, 입력 처리의 위험한 선택지를 줄인 인터페이스를 제공한다. TLS에서 ECDHE의 `E`는 ephemeral을 뜻한다. 연결마다 임시 key pair를 만들고 shared secret을 KDF에 넣어 실제 traffic key를 유도한다. shared secret 원문을 그대로 AES key로 잘라 쓰지 않는다. transcript와 역할·알고리즘 문맥을 HKDF에 결합해야 key 재사용과 프로토콜 간 혼동을 막을 수 있다.

### DH는 수동 도청자만 막는다

인증되지 않은 DH에서 Mallory는 Alice와 Bob 사이 값을 가로채 각각 자기 공개 값으로 바꿀 수 있다.

```text
Alice <── DH shared secret 1 ──> Mallory <── DH shared secret 2 ──> Bob
```

양 끝은 안전하게 합의했다고 생각하지만 Mallory가 모든 메시지를 복호·변조·재암호화한다. DH가 실패한 것이 아니라 위협 모델에 신원 인증이 없었다. 공개 key나 handshake transcript에 대한 서명이 필요하고, 그 서명 key가 누구 것인지 신뢰하는 방법은 [3.4 인증서](./04-certificates-and-tls-trust-chain.md)가 맡는다.

### RSA는 공개 연산과 개인 연산을 분리한다

RSA는 큰 두 소수의 곱 `n`을 공개 modulus로 쓰고, 공개 exponent `e`와 개인 exponent `d`를 구성한다. 공개 정보에서 개인 key를 복구하기 어렵다는 가정은 큰 정수의 소인수분해 문제와 밀접하다. 수론적 정당성 증명은 이 장의 범위 밖이다.

교과서식 `m^e mod n`, `c^d mod n`만으로 메시지를 암호화하면 결정적이고 구조가 있어 안전하지 않다. RSA encryption에는 OAEP 같은 검증된 padding scheme이 필요하다. RSA signature도 "hash를 private key로 암호화"한 것과 동일시하면 인코딩 검증을 놓친다. RSASSA-PSS처럼 메시지 digest와 salt를 명확한 형식으로 encoding하고 그 형식을 검증하는 별도 signature scheme이다.

RSA는 입력 크기가 modulus와 padding에 제한되고 대칭 암호보다 비싸다. 따라서 큰 파일이나 HTTP body를 RSA 블록으로 나누어 암호화하지 않는다. 현대 시스템은 비대칭 연산으로 작은 shared secret 또는 content-encryption key를 보호하고, 실제 데이터는 AEAD로 처리한다.

### 하이브리드 암호는 각 프리미티브의 장점을 조립한다

수신자의 공개 key로 데이터를 보내는 전형적인 envelope encryption은 다음 책임을 나눈다.

```text
random data key ──▶ AEAD로 대용량 plaintext 암호화
      │
      └───────────▶ 수신자 공개 key로 data key encapsulation/보호
```

여러 수신자에게는 ciphertext 본문 하나를 두고 data key만 수신자별로 감싼다. 클라우드 KMS의 envelope encryption도 비슷한 경계를 사용한다. 알고리즘 agility, key ID, nonce, recipient, ciphertext를 인증된 포맷에 포함하지 않으면 key 바꿔치기나 downgrade 위험이 생긴다.

TLS 1.3의 일반적인 인증서 handshake는 RSA로 application data를 암호화하지 않는다. ECDHE로 shared secret을 합의하고, 인증서의 장기 key는 handshake 서명에 쓰며, HKDF가 traffic key를 만들고 AEAD가 record를 보호한다. TLS 1.3 cipher suite 이름에서도 key exchange와 signature가 분리되어 있다는 점을 [3.4](./04-certificates-and-tls-trust-chain.md)에서 다시 확인한다.

### 디지털 서명은 key 소유를 검증한다

디지털 서명(signature)은 private key 소유자가 메시지에 서명하고 public key 소유자는 누구나 검증할 수 있게 한다.

```text
signature = Sign(privateKey, message)
valid = Verify(publicKey, message, signature)
```

실제 scheme은 메시지의 digest와 문맥을 정해진 인코딩으로 처리한다. 애플리케이션이 임의로 "먼저 SHA-256하고 raw signing"할 필요가 없다. 서명 API가 hash·encoding을 포함하는지, domain separation과 serialization이 모호하지 않은지를 확인한다.

| 질문 | HMAC | 디지털 서명 |
|---|---|---|
| tag/signature 생성 | shared secret 보유자 | private key 보유자 |
| 검증 | 같은 secret 보유자 | public key를 얻은 누구나 |
| 검증자의 위조 능력 | 있음 | 없음 |
| 대표 용도 | 서비스 간 요청 인증, 세션 token | 코드·문서·handshake 출처 검증 |

"부인 방지(non-repudiation)"는 수학만으로 자동 성립하지 않는다. private key가 누가 통제했는지, malware·공유 계정·HSM·timestamp·감사 로그를 함께 봐야 법적·운영적 귀속을 주장할 수 있다. 서명이 직접 증명하는 것은 특정 private key에 대응하는 연산이 메시지에 대해 수행됐다는 사실이다. 사람이 내용을 이해하고 승인했다는 뜻은 아니다.

### JWT 알고리즘 선택은 trust topology 선택이다

JWT의 HS256은 HMAC-SHA-256이다. 발급자와 검증자가 같은 secret을 가지므로 모든 검증자가 token을 새로 만들 수도 있다. RS256은 RSA signature라 발급자만 private key를 가지고 검증자는 public key만 가져도 된다.

과거의 알고리즘 혼동 취약점은 token header의 `alg`를 무조건 신뢰하고 같은 key material을 HMAC과 RSA 검증에 다르게 해석할 때 발생했다. 검증자는 허용 알고리즘을 설정에서 고정하고, key를 algorithm·issuer·audience와 함께 선택하며, header가 보안 정책을 결정하게 두지 않는다. JWT의 세션·OAuth 설계 자체는 이 장 범위가 아니다.

### ephemeral key는 과거 traffic을 장기 key 유출에서 분리한다

서버의 장기 RSA private key로 매 세션의 대칭 key를 직접 복호하는 구조에서는 공격자가 traffic을 저장해 두었다가 장기 key를 훗날 얻으면 과거 세션도 복호할 수 있다. Ephemeral DH는 연결마다 임시 private key를 만들고 handshake 뒤 폐기한다. 장기 서명 key는 임시 key가 포함된 transcript를 인증할 뿐 shared secret을 계산하는 데 쓰이지 않는다.

이것이 forward secrecy다. 나중의 장기 인증 key 유출만으로 과거 session secret을 복원할 수 없다. 단, endpoint가 연결 중 session key나 plaintext를 유출했거나, 난수 생성기가 예측 가능하거나, session ticket key가 넓게 공유되면 별도 위험이 남는다. TLS 1.3이 static RSA key exchange를 제거한 배경에도 이 분리가 있다.

## 미니 실험: toy DH를 깨고 X25519와 대조한다

다음 코드는 작은 group에서는 공개 값에서 비밀 exponent를 전수 탐색할 수 있음을 보인 뒤 Node.js의 X25519 API로 같은 shared secret을 계산한다. toy DH는 교육용이며 프로덕션에서 절대 사용하지 않는다.

```js
import {
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto";

function modPow(base, exponent, modulus) {
  let result = 1n;
  for (let b = base % modulus, e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
  }
  return result;
}

const p = 104_729n;
const g = 12n;
const aliceSecret = 45_321n;
const alicePublic = modPow(g, aliceSecret, p);

const started = performance.now();
let recovered = 0n;
for (let candidate = 1n; candidate < p; candidate++) {
  if (modPow(g, candidate, p) === alicePublic) {
    recovered = candidate;
    break;
  }
}
console.log({ recovered, milliseconds: performance.now() - started });

const alice = generateKeyPairSync("x25519");
const bob = generateKeyPairSync("x25519");
const aliceShared = diffieHellman({ privateKey: alice.privateKey, publicKey: bob.publicKey });
const bobShared = diffieHellman({ privateKey: bob.privateKey, publicKey: alice.publicKey });
console.log({
  equal: aliceShared.equals(bobShared),
  sharedBytes: aliceShared.length,
  publicDerBytes: alice.publicKey.export({ type: "spki", format: "der" }).length,
});
```

핵심 관찰은 작은 `p`의 brute force가 금방 끝나고, 표준 X25519에서는 양쪽 32바이트 shared secret이 같다는 것이다. 실행 시간이 짧다는 사실이 X25519를 쉽게 역산할 수 있다는 뜻은 아니다. 정방향 scalar multiplication과 역방향 discrete log는 다른 문제다.

## 실무 관점: "public key가 있다" 다음에 물을 것

- 그 key가 누구 것인지 어떤 독립 채널로 확인했는가? SSH의 known_hosts, package maintainer key, CA chain은 서로 다른 답이다.
- encryption key와 signing key의 용도를 인증서·KMS policy·API에서 분리했는가?
- 받은 public key와 curve point를 검증된 API가 검사하는가?
- shared secret을 transcript와 역할에 묶어 KDF로 유도했는가?
- private key가 파일, 환경 변수, HSM 중 어디에 있고 복사·rotation·폐기 범위는 무엇인가?
- algorithm identifier와 key type을 공격자 입력이 임의로 교차 선택하지 못하게 했는가?

SSH 첫 접속의 TOFU(Trust On First Use)는 처음 본 host key를 저장하고 이후 변경을 경고한다. 코드·패키지 서명은 public key나 transparency log를 어떤 채널로 신뢰했는지가 핵심이다. public key는 비밀이 아니지만 **진위와 최신성**은 자동으로 주어지지 않는다.

## 더 깊이: 포스트양자 전환은 key inventory 문제이기도 하다

충분히 큰 오류 보정 양자 컴퓨터에서 Shor 알고리즘은 RSA의 소인수분해와 DH·ECC의 이산로그 가정을 위협한다. 대칭 암호와 hash는 같은 방식으로 완전히 무너지지는 않지만 보안 파라미터 재평가가 필요하다. NIST는 2024년 FIPS 203(ML-KEM), FIPS 204(ML-DSA), FIPS 205(SLH-DSA)를 최종 표준으로 승인했다.

전환은 알고리즘 이름 교체만이 아니다. 더 큰 key·ciphertext·signature가 프로토콜 메시지, 인증서, MTU와 저장소에 주는 비용을 측정해야 한다. 장기간 비밀이어야 하는 데이터는 "지금 수집하고 나중에 복호" 공격도 고려한다. 따라서 조직은 먼저 RSA·DH·ECC가 어디에 쓰이는지, data confidentiality가 몇 년 필요한지, protocol과 library가 hybrid migration을 지원하는지 inventory를 만든다. 구체적인 도입 시점은 제품·표준 프로파일·위협 모델의 최신 지침으로 결정한다.

## 정리

- 공개키 암호는 key 분배를 private/public key 구조로 바꾸지만 public key의 신원은 별도 문제다.
- DH·ECDH는 secret을 보내지 않고 합의하지만 인증 없이는 MITM을 막지 못한다.
- RSA는 적절한 encryption/signature scheme과 padding이 필요하며 대용량 데이터는 AEAD가 맡는다.
- 디지털 서명은 private key와 public verification을 분리한다. HMAC 검증자는 동시에 위조 능력도 가진다.
- ephemeral DH는 장기 key 유출에서 과거 session을 분리하지만 endpoint·ticket·난수 위험까지 없애지는 않는다.

## 확인 문제

**1.** 사내 webhook 검증자 30개가 모두 HS256 secret을 공유한다. 한 검증 서비스가 침해됐을 때의 영향과 RS256으로 바꿀 때의 trade-off를 설명하라.

::: details 정답과 해설
HS256 검증자는 secret으로 유효한 token도 만들 수 있어 하나의 침해가 발급 권한 침해로 번진다. RS256에서는 검증자에 public key만 배포해 위조 능력을 분리할 수 있다. 대신 private key 보호, public key rotation·캐시·key ID 관리와 더 큰 서명·연산 비용을 운영해야 한다.
:::

**2.** ECDHE handshake에서 양쪽 shared secret이 같음을 확인했는데도 MITM에 취약할 수 있는 이유는 무엇인가?

::: details 정답과 해설
각 endpoint가 상대가 아니라 공격자와 정상적인 ECDH를 완료했을 수 있다. shared secret 일치는 그 세션의 수학적 합의만 증명한다. 신뢰한 장기 key로 ephemeral key와 transcript를 인증하고 그 장기 public key의 신원을 검증해야 한다.
:::

**3.** 서버 장기 인증 key가 유출됐지만 과거 TLS 1.3 packet을 복호하지 못했다. 어떤 설계가 기여했고, 여전히 확인할 예외는 무엇인가?

::: details 정답과 해설
연결별 ephemeral ECDHE private key를 폐기해 forward secrecy를 제공한 것이 핵심이다. 당시 endpoint의 session secret 유출, 약한 RNG, key log 보관, PSK/session ticket key 관리와 실제 협상 모드를 별도로 확인한다.
:::

## 참고 자료

- [Diffie & Hellman, New Directions in Cryptography](https://ee.stanford.edu/~hellman/publications/24.pdf): 공개 채널 key agreement와 public-key cryptography의 문제 설정을 제시한다.
- [RFC 7748 — Elliptic Curves for Security](https://www.rfc-editor.org/rfc/rfc7748.html): X25519·X448 함수와 encoding을 정의한다.
- [RFC 8017 — PKCS #1 v2.2](https://www.rfc-editor.org/rfc/rfc8017.html): RSA-OAEP와 RSASSA-PSS의 구조·검증 기준이다.
- [RFC 8032 — EdDSA](https://www.rfc-editor.org/rfc/rfc8032.html): Ed25519·Ed448 signature scheme을 정의한다.
- [RFC 8446 — TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html): ECDHE, certificate signature, HKDF와 forward secrecy가 조립되는 기준이다.
- [NIST FIPS 203·204·205 발표](https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards): 최초 세 포스트양자 표준의 역할과 전환 배경을 설명한다.
- [Node.js Crypto 문서](https://nodejs.org/api/crypto.html): X25519 key pair와 `diffieHellman` 실험의 API 기준이다.
