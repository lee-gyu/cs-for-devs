# 3.2 대칭 암호와 무결성 — 숨기는 것과 변조를 찾는 것은 다르다

> 안전한 알고리즘 이름은 충분조건이 아니다. 키·nonce·인증 태그의 계약을 지켜야 기밀성과 무결성이 함께 성립한다.

## 학습 목표

- 대칭 암호의 보장을 Kerckhoffs 원리와 키 관리 가정으로 설명한다.
- ECB·CBC·CTR·GCM의 구조와 IV·nonce 요구사항을 비교한다.
- 암호학적 해시, MAC, AEAD가 제공하는 서로 다른 무결성 계약을 구분한다.
- HKDF와 비밀번호 KDF의 목적을 구분하고 salt·work factor를 설계한다.
- 라이브러리의 key·nonce·tag 파라미터 오용이 어떤 공격으로 이어지는지 진단한다.

## 배경: 알고리즘을 숨겨서는 보안을 검증할 수 없다

암호 시스템은 설계와 구현이 알려져도 키를 모르면 안전해야 한다. 이를 Kerckhoffs 원리라 한다. 공격자가 알고리즘 이름, 소스 코드, 다수의 평문·암호문 쌍을 안다고 가정해야 공개 검토와 교체 가능한 키에 보안을 집중할 수 있다. 비밀 알고리즘은 유출 뒤 전체 시스템을 교체해야 하고, 분석되지 않은 약점을 숨긴다.

대칭 암호(symmetric cryptography)는 송신자와 수신자가 같은 비밀 키를 공유한다고 가정한다. 이 장의 질문은 "이미 키를 공유한 둘이 무엇을 할 수 있는가"다. 그 키를 처음 어떻게 나누는지는 [3.3 키 교환](./03-asymmetric-crypto-and-key-exchange.md)에서 다룬다.

## 핵심 개념

### one-time pad는 완전 비밀성의 가격을 보여 준다

평문 `P`와 같은 길이의 균등 난수 키 `K`를 XOR하면 암호문 `C`를 얻는다.

```text
C = P XOR K
P = C XOR K
```

키가 정말 균등하고, 평문만큼 길며, 단 한 번만 쓰인다면 암호문만 보고 평문 후보의 확률을 좁힐 수 없다. 모든 평문 후보마다 그 후보를 만드는 키가 하나씩 존재하기 때문이다. 이것이 정보 이론적 완전 비밀성이다.

하지만 키 배송량이 메시지와 같고 재사용할 수 없다. 같은 키스트림을 두 번 쓰면 `C₁ XOR C₂ = P₁ XOR P₂`가 되어 키가 사라지고 두 평문의 관계가 노출된다. 실용 암호는 짧은 랜덤 키에서 계산적으로 예측하기 어려운 긴 변환을 만들고, 완전 비밀성 대신 현실적인 계산 자원으로 깨기 어렵다는 계약을 택한다.

### 스트림 암호와 블록 암호

스트림 암호(stream cipher)는 key와 nonce로 의사난수 키스트림을 만들고 평문과 XOR한다. ChaCha20이 대표적이다. 블록 암호(block cipher)는 고정 크기 블록에서 키로 선택되는 가역 치환이다. AES는 128비트 블록과 128·192·256비트 키를 쓰는 표준 블록 암호다. substitution과 permutation을 여러 라운드 반복하지만, 애플리케이션이 의존할 계약은 "검증된 키 기반 블록 치환"이지 내부 라운드를 재조립하는 방법이 아니다.

블록 암호는 한 블록만 정의한다. 긴 메시지와 반복 패턴을 안전하게 처리하려면 운용 모드(mode of operation)가 필요하다.

### ECB는 구조를 그대로 복사한다

Electronic Codebook(ECB)은 각 블록을 독립적으로 암호화한다.

```text
Cᵢ = E(K, Pᵢ)
```

같은 key에서 같은 평문 블록은 같은 암호문 블록이 된다. 공격자가 내용을 바로 읽지 못해도 반복 위치와 형태를 안다. 데이터베이스의 낮은 cardinality 열, 고정 형식 레코드, 이미지의 넓은 단색 영역에서 이 누출은 의미가 크다. ECB는 일반 메시지 암호화 모드로 사용하지 않는다.

### CBC는 앞 암호문을 섞지만 인증하지 않는다

Cipher Block Chaining(CBC)은 평문 블록을 직전 암호문과 XOR한 뒤 암호화한다.

```text
C₀ = IV
Cᵢ = E(K, Pᵢ XOR Cᵢ₋₁)
```

첫 블록을 위한 initialization vector(IV)는 같은 key 아래에서 예측 불가능하고 새로 생성되어야 한다. 같은 평문도 IV가 다르면 다른 암호문이 된다. 블록 크기에 맞지 않는 마지막 평문에는 padding이 필요하다.

CBC는 기밀성만 제공한다. 공격자가 직전 암호문 블록을 바꾸면 다음 평문 블록의 대응 비트가 바뀐다. padding 오류의 차이를 외부에 노출하면 padding oracle이 평문을 점진적으로 복구할 수도 있다. "복호 오류를 하나로 만들기"는 완화일 뿐이며, 인증 없는 CBC를 새 설계에 선택할 이유는 거의 없다.

### CTR은 블록 암호를 키스트림 생성기로 쓴다

Counter(CTR) 모드는 nonce와 증가하는 counter 블록을 암호화해 키스트림을 만든다.

```text
Sᵢ = E(K, nonce || counterᵢ)
Cᵢ = Pᵢ XOR Sᵢ
```

블록을 병렬 처리하고 padding 없이 임의 길이를 다룰 수 있다. 그러나 같은 key와 nonce를 재사용하면 같은 키스트림이 생성되어 one-time pad 재사용과 똑같이 무너진다. 더구나 CTR 암호문의 비트를 뒤집으면 복호된 평문의 같은 비트가 예측 가능하게 뒤집힌다. 암호화 성공은 변조 감지가 아니다.

### AEAD는 기밀성과 무결성을 한 API로 묶는다

Authenticated Encryption with Associated Data(AEAD)는 암호문과 인증 태그(tag)를 함께 만든다.

```text
(ciphertext, tag) = Seal(key, nonce, plaintext, associatedData)
plaintext         = Open(key, nonce, ciphertext, associatedData, tag)
```

AES-GCM과 ChaCha20-Poly1305가 널리 쓰인다. associated data(AAD)는 헤더처럼 공개되어도 되지만 변조되어서는 안 되는 값을 인증 범위에 넣는다. 수신자는 tag를 검증한 뒤에만 평문을 사용해야 한다. 검증 실패는 부분 평문이나 상세 원인을 외부에 제공하지 않고 전체 메시지를 거부해야 한다.

GCM의 nonce는 비밀일 필요가 없지만 **같은 key에서 재사용되면 안 된다**. 재사용은 CTR 키스트림 관계를 노출하고 인증 키에 관한 식까지 제공해 위조 가능성을 연다. 랜덤 96비트 nonce는 작은 규모에서 충돌 확률이 낮지만, 대규모·장수 key에서는 중앙 카운터, 프로세스별 prefix와 counter, 주기적 key rotation처럼 유일성을 설계해야 한다. 라이브러리가 nonce를 자동 생성하지 않는다면 단순히 `Date.now()`를 넣어서는 다중 프로세스와 재시작을 견디지 못한다.

### 해시는 키 없는 고정 길이 지문이다

암호학적 해시 함수 `H`는 임의 길이 입력을 고정 길이 digest로 보낸다. 암호화와 달리 복호 key가 없고 되돌리는 연산을 제공하지 않는다. 중요한 세 성질은 서로 다르다.

| 성질 | 공격자에게 주어진 것 | 어려워야 하는 일 |
|---|---|---|
| 역상 저항성 | digest `h` | `H(m)=h`인 임의의 `m` 찾기 |
| 제2역상 저항성 | 특정 `m` | `H(m')=H(m)`인 다른 `m'` 찾기 |
| 충돌 저항성 | 없음 | 해시가 같은 임의의 서로 다른 두 입력 찾기 |

`n`비트 해시의 이상적 역상 탐색은 약 `2^n`, 충돌 탐색은 생일 역설 때문에 약 `2^(n/2)` 작업이 기준이다. 이 숫자는 특정 알고리즘의 구조적 공격과 구현 결함을 제외한 모델이다.

키 없는 해시는 파일의 우연한 손상을 비교하는 데 쓸 수 있지만 공격자에 대한 출처 인증은 제공하지 않는다. 공격자는 메시지를 바꾸고 해시도 다시 계산할 수 있다.

### `hash(key || message)`는 MAC의 안전한 조립법이 아니다

SHA-256 같은 Merkle–Damgård 구조는 내부 상태를 다음 블록으로 이어 간다. `hash(key || message)`의 digest와 전체 길이를 아는 공격자는 key를 몰라도 padding 뒤에 `suffix`를 붙인 메시지의 digest를 계산할 수 있다. 이것이 길이 확장 공격(length-extension attack)이다. SHA-3처럼 구조가 다른 해시에 같은 공격이 그대로 적용되지는 않지만 임의 조립을 정당화하지는 않는다.

Hash-based Message Authentication Code(HMAC)는 다음 구조로 내부·외부 해시를 분리한다.

```text
HMAC(K, m) = H((K' XOR opad) || H((K' XOR ipad) || m))
```

HMAC은 비밀 키를 가진 참여자만 유효한 tag를 만들고 검증하도록 한다. 기존 프로토콜이 HMAC을 요구하면 표준 API를 사용한다. 새 암호화 프로토콜은 "encrypt 후 HMAC"의 key 분리와 순서까지 직접 조립하기보다 AEAD를 우선한다.

### Encrypt-then-MAC은 검증 뒤 복호한다

암호화와 MAC을 별도로 조합해야 한다면 독립적으로 유도한 key를 쓰고 ciphertext와 필요한 메타데이터를 MAC한다.

```text
ciphertext = Encrypt(K_enc, plaintext)
tag = MAC(K_mac, version || nonce || ciphertext || context)
```

수신자는 tag를 먼저 검증하고 성공한 경우에만 복호한다. 같은 master key를 암호화와 MAC에 그대로 쓰거나, nonce·알고리즘 버전·메시지 타입을 인증 범위에서 빼면 cross-protocol 또는 재배치 공격면이 생긴다. 이것이 고수준 AEAD API가 안전한 기본값인 이유다.

### KDF는 약한 비밀번호와 강한 key를 서로 다른 방식으로 다룬다

Key Derivation Function(KDF)에는 두 문제가 있다.

HKDF는 이미 충분한 엔트로피를 가진 shared secret에서 서로 독립된 여러 key를 만든다. `Extract`가 입력을 pseudorandom key로 정규화하고 `Expand`가 `info` 문맥별 key를 만든다. HKDF는 비밀번호를 느리게 탐색하게 만들지 않는다.

비밀번호 KDF는 사람이 고른 낮은 엔트로피 입력의 오프라인 대입 비용을 높인다. Argon2id, scrypt, bcrypt, PBKDF2가 이 범주다. 새 시스템은 플랫폼과 정책에 맞는 memory-hard KDF를 우선 검토한다.

- **salt**는 사용자마다 랜덤하게 생성해 같은 비밀번호의 결과를 다르게 만들고 사전 계산을 무력화한다. 비밀일 필요가 없다.
- **work factor**와 memory cost는 공격자와 서버 양쪽의 시도 비용을 높인다. 실제 인증 서버의 지연·메모리 예산으로 조정하고 파라미터를 hash와 함께 저장한다.
- **pepper**는 선택적인 서버 측 비밀이다. 데이터베이스와 분리된 secret manager/HSM에 두어야 의미가 있고, rotation 비용이 있다.

`SHA-256(password + salt)`는 salt가 있어도 GPU가 매우 빠르게 후보를 시험할 수 있다. 빠른 해시는 파일 무결성과 서명 전처리에는 장점이지만 비밀번호 저장에는 약점이다.

## 미니 실험: ECB가 이미지 구조를 남기는지 본다

다음 Node.js 24 스크립트는 256×256 grayscale 패턴을 만들고, AES-ECB와 AES-GCM ciphertext의 앞 65,536바이트를 PGM 이미지로 저장한다. 암호 구현 예제가 아니라 실패 모드 관찰용이다.

```js
import { createCipheriv, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const width = 256;
const height = 256;
const pixels = Buffer.alloc(width * height, 245);
for (let y = 40; y < 216; y++) {
  for (let x = 64; x < 192; x++) {
    if ((x < 96 || x > 160) || (y > 96 && y < 128)) {
      pixels[y * width + x] = 30;
    }
  }
}

function encrypt(name, iv) {
  const cipher = createCipheriv(name, Buffer.alloc(16, 7), iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pixels), cipher.final()]);
}

function pgm(path, bytes) {
  writeFileSync(path, Buffer.concat([
    Buffer.from(`P5\n${width} ${height}\n255\n`),
    bytes.subarray(0, width * height),
  ]));
}

pgm("plain.pgm", pixels);
pgm("ecb.pgm", encrypt("aes-128-ecb", null));

const gcm = createCipheriv("aes-128-gcm", Buffer.alloc(16, 7), randomBytes(12));
const gcmBytes = Buffer.concat([gcm.update(pixels), gcm.final()]);
gcm.getAuthTag(); // 실제 저장 포맷은 nonce와 tag도 함께 보존해야 한다.
pgm("gcm.pgm", gcmBytes);
```

macOS Preview 등 PGM을 여는 도구로 세 파일을 비교한다. ECB 결과에는 원본의 넓은 반복 블록 경계가 남고 GCM ciphertext는 구조를 구분하기 어렵다. GCM이 "더 랜덤해 보인다"는 시각적 관찰은 보안 증명이 아니다. 실제 안전성은 nonce 유일성, key 비밀성, tag 보존·검증 계약에서 나온다.

## 실무 관점: 라이브러리 호출 전에 확인할 계약

| 질문 | 안전한 기준 |
|---|---|
| 알고리즘 | 새 설계는 검증된 AEAD를 사용하고 임의 조합을 피한다 |
| key | CSPRNG 또는 적절한 KDF로 만들고 목적·tenant·환경별 범위를 분리한다 |
| nonce | 같은 key에서 유일성을 보장하며 ciphertext와 함께 저장한다 |
| AAD | version, record type, 식별자 등 공개되지만 바뀌면 안 되는 문맥을 포함한다 |
| tag | 상수 시간 검증이 포함된 `open` API를 쓰고 실패 평문을 사용하지 않는다 |
| rotation | 기존 ciphertext를 읽을 key version과 새 쓰기 key를 구분한다 |
| 오류 | padding·tag·parse 실패를 공격자에게 구별 가능한 oracle로 노출하지 않는다 |

압축은 암호화 전에 수행해야 효과가 있지만, secret과 공격자 제어 입력을 함께 압축하고 길이를 노출하면 부채널이 생긴다. 구체적인 HTTP 압축 공격은 챕터 9의 전송 맥락에 위임한다. 민감한 응답에서 압축을 끄거나 secret과 반사 입력을 분리하고 길이 padding을 검토하되, 임의 padding이 모든 트래픽 분석을 제거한다고 가정하지 않는다.

## 더 깊이: 표준 알고리즘과 안전한 프로토콜 사이

AES-GCM이 표준이라는 사실은 시스템 전체가 안전하다는 뜻이 아니다. key를 로그에 남기거나, 여러 서비스가 nonce 공간을 공유하거나, tag 길이를 임의로 줄이거나, 복호된 객체를 권한 확인 전에 사용하면 프리미티브의 증명 범위 밖이다. 암호 프로토콜의 형식 검증은 챕터 2의 논리·검증 응용에서 다룬다.

프로덕션에서는 ciphertext 포맷도 계약이다. 최소한 알고리즘·버전, key ID, nonce, ciphertext, tag를 모호하지 않은 길이와 순서로 직렬화하고 전체 문맥을 인증한다. 마이그레이션을 위해 여러 버전을 읽더라도 공격자가 버전 필드를 낮춰 약한 경로를 선택하지 못하게 해야 한다.

## 정리

- 대칭 암호는 알고리즘이 공개되어도 key가 비밀이면 안전해야 한다.
- ECB는 반복 구조를 노출하고 CBC·CTR도 단독으로는 변조를 막지 않는다.
- AEAD는 ciphertext와 AAD를 인증하지만 key별 nonce 유일성과 tag 검증이 필수다.
- 해시는 키 없는 지문이고 HMAC은 공유 key 기반 메시지 인증이다. 둘 다 암호화의 다른 이름이 아니다.
- HKDF는 강한 shared secret을 문맥별 key로 확장하고, Argon2 계열 같은 비밀번호 KDF는 오프라인 탐색 비용을 높인다.

## 확인 문제

**1.** AES-CTR로 암호화한 `admin=false` 레코드가 공격자에게 노출됐다. key를 몰라도 값 변조가 가능한 이유와 막는 방법을 설명하라.

::: details 정답과 해설
CTR은 ciphertext와 키스트림의 XOR이므로 ciphertext의 특정 비트를 뒤집으면 평문의 같은 비트가 뒤집힌다. 공격자가 형식과 위치를 알면 예측 가능한 변조가 가능하다. 새 설계는 nonce를 올바르게 관리하는 AEAD를 사용하고 tag 검증 뒤에만 평문을 처리한다.
:::

**2.** 여러 서버가 같은 GCM key를 쓰고 각자 0부터 counter nonce를 시작한다. 어떤 계약이 깨졌고 프로세스별 랜덤 nonce면 항상 해결되는가?

::: details 정답과 해설
같은 key에서 nonce가 재사용되어 기밀성과 tag 위조 저항성이 모두 깨진다. 프로세스별 랜덤 nonce는 충돌 확률을 낮출 뿐 무한히 보장하지 않는다. 고유한 프로세스 prefix와 영속 counter, 중앙 할당, 충분한 확률 예산과 key rotation 중 운영 조건에 맞는 전략을 설계한다.
:::

**3.** 비밀번호 저장을 SHA-256에서 Argon2id로 바꾸면 salt가 더는 필요 없는가?

::: details 정답과 해설
필요하다. 느리고 memory-hard한 계산은 각 후보의 비용을 높이고, 사용자별 랜덤 salt는 같은 비밀번호가 같은 결과가 되는 것과 사전 계산 재사용을 막는다. 서로 다른 목적의 방어다.
:::

**4.** 다운로드 파일과 SHA-256 digest를 같은 서버에서 HTTPS로 제공하면 digest는 어떤 실패를 찾고 어떤 공격은 못 막는가?

::: details 정답과 해설
전송·저장 중 우연한 손상과 기대한 파일과의 불일치를 찾을 수 있다. 그러나 서버나 배포 경로를 장악한 공격자는 파일과 digest를 함께 바꿀 수 있다. 독립적으로 신뢰한 서명 key나 별도 채널이 출처 인증에 필요하다.
:::

## 참고 자료

- [FIPS 197 — Advanced Encryption Standard](https://csrc.nist.gov/pubs/fips/197/final): AES의 블록·key 크기와 알고리즘을 정의한다.
- [NIST SP 800-38A](https://csrc.nist.gov/pubs/sp/800/38/a/final): ECB·CBC·CTR 등 블록 암호 운용 모드의 기준이다.
- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final): GCM/GMAC과 IV·tag 요구사항을 정의한다.
- [RFC 2104 — HMAC](https://www.rfc-editor.org/rfc/rfc2104.html): HMAC의 표준 구성과 설계 목표를 설명한다.
- [RFC 5869 — HKDF](https://www.rfc-editor.org/rfc/rfc5869.html): extract-and-expand key derivation을 정의한다.
- [RFC 9106 — Argon2](https://www.rfc-editor.org/rfc/rfc9106.html): Argon2 변형과 권장 파라미터 선택의 기준이다.
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html): 비밀번호 verifier 저장과 인증 수명주기 지침을 제공한다.
- [Node.js Crypto 문서](https://nodejs.org/api/crypto.html): `Cipheriv`, AEAD tag와 Node.js 24의 Argon2 API 기준이다.
