// 30일치 분 단위 요청 로그를 생성한다. (Node 24 기준: node generate-logs.ts)
//
// 출력: requests.ndjson — 한 줄이 1분의 집계다.
//   { "t": "2026-06-01T00:00:00Z", "requests": 412, "errors": 0, "slow": 1 }
//   errors: 5xx 응답 수, slow: 성공했지만 800ms를 넘긴 응답 수
//
// 시드가 고정되어 있어 누구나 같은 로그를 얻는다.
// 어떤 장애 시나리오가 며칠에 주입되어 있는지는 로그를 분석해 직접 찾는 것이
// 실습의 일부이므로, 이 파일의 scenarios 정의를 먼저 읽지 않기를 권한다.

import { writeFileSync } from "node:fs";

// 결정적 의사난수 (mulberry32)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260712);

const START = Date.UTC(2026, 5, 1); // 2026-06-01T00:00:00Z
const DAYS = 30;
const TOTAL_MINUTES = DAYS * 24 * 60;

// d일 h시 m분(1-기준 일자)을 분 오프셋으로 변환
const at = (d: number, h = 0, m = 0): number => ((d - 1) * 24 + h) * 60 + m;

interface Scenario {
  label: string;
  from: number; // 분 오프셋 (포함)
  to: number; // 분 오프셋 (미포함)
  errorRate?: number; // 해당 구간의 오류율 (기본율을 대체)
  slowRate?: number; // 해당 구간의 지연 초과율 (기본율을 대체)
}

const scenarios: Scenario[] = [
  // 배포 직후 전면 장애: 짧고 격렬한 소진
  { label: "full-outage", from: at(8, 14, 5), to: at(8, 14, 48), errorRate: 0.95 },
  // 하위 서비스 성능 저하: 오류는 없지만 지연 SLI가 소진됨
  { label: "latency-degradation", from: at(13, 9, 0), to: at(13, 21, 0), slowRate: 0.08 },
  // 저강도 지속 오류: 빠른 경보에는 안 걸리지만 예산을 서서히 태움
  { label: "slow-burn", from: at(17, 0, 0), to: at(23, 0, 0), errorRate: 0.004 },
  // 카나리 배포: 트래픽 1%에만 결함 노출 (전체 오류율로는 1%)
  { label: "canary-defect", from: at(26, 11, 0), to: at(26, 12, 0), errorRate: 0.01 },
];

const BASE_ERROR_RATE = 0.0004;
const BASE_SLOW_RATE = 0.002;

// 기대값 rate*n에 확률적 잔차를 더한 근사 표본
function sample(n: number, rate: number): number {
  const expected = n * rate;
  const base = Math.floor(expected);
  const frac = expected - base;
  return base + (rand() < frac ? 1 : 0);
}

const lines: string[] = [];

for (let minute = 0; minute < TOTAL_MINUTES; minute += 1) {
  const hourOfDay = Math.floor(minute / 60) % 24;

  // 하루 주기 트래픽: 새벽에 낮고 낮에 높다 (분당 약 60~700 요청)
  const daily = 380 - 320 * Math.cos(((hourOfDay - 14 + 24) % 24) * (Math.PI / 12) - Math.PI);
  const requests = Math.max(30, Math.round(daily * (0.9 + rand() * 0.2)));

  let errorRate = BASE_ERROR_RATE;
  let slowRate = BASE_SLOW_RATE;
  for (const s of scenarios) {
    if (minute >= s.from && minute < s.to) {
      if (s.errorRate !== undefined) errorRate = s.errorRate;
      if (s.slowRate !== undefined) slowRate = s.slowRate;
    }
  }

  const errors = Math.min(requests, sample(requests, errorRate));
  const slow = Math.min(requests - errors, sample(requests, slowRate));

  const t = new Date(START + minute * 60_000).toISOString().replace(".000Z", "Z");
  lines.push(JSON.stringify({ t, requests, errors, slow }));
}

writeFileSync(new URL("./requests.ndjson", import.meta.url), lines.join("\n") + "\n");

console.log(`requests.ndjson: ${TOTAL_MINUTES}분(${DAYS}일) 분량 생성 완료`);
