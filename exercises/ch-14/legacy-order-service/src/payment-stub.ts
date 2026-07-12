// 로컬 결제 스텁 서버. 레거시 서비스를 실행 관찰할 때만 필요하다.
// FAIL_RATE(0~1)와 DELAY_MS로 실패·지연을 주입할 수 있다.
//   PORT=4242 FAIL_RATE=0.3 DELAY_MS=200 node src/payment-stub.ts

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4242);
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);

let seq = 0;

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/charge") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    setTimeout(() => {
      if (Math.random() < FAIL_RATE) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "declined" }));
        return;
      }
      seq += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "approved", txId: `TX-${seq}`, request: JSON.parse(body) }));
    }, DELAY_MS);
  });
}).listen(PORT, () => {
  console.log(`payment stub listening on :${PORT} (FAIL_RATE=${FAIL_RATE}, DELAY_MS=${DELAY_MS})`);
});
