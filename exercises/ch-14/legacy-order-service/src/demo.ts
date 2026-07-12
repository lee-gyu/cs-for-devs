// 레거시 서비스의 현재 동작을 실행으로 관찰하는 데모.
// 먼저 다른 터미널에서 결제 스텁을 띄운다: node src/payment-stub.ts

import { confirmOrder, inventory } from "./order-service.ts";

console.log("재고(전):", inventory);

console.log(await confirmOrder([{ sku: "KEYBOARD-01", unitPrice: 89_000, quantity: 1 }]));
console.log(await confirmOrder([{ sku: "MONITOR-01", unitPrice: 300_000, quantity: 99 }]));
console.log(await confirmOrder([])); // 빈 주문은 어떻게 되는가?
console.log(await confirmOrder([{ sku: "MOUSE-01", unitPrice: 35_000, quantity: -3 }])); // 음수 수량은?

console.log("재고(후):", inventory);
