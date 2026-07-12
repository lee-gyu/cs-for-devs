// 실습용 레거시 주문 확정 서비스.
// 시간·전역 상태·외부 호출이 의도적으로 얽혀 있다.
// Part A의 시작점이므로 특성화 테스트를 씌우기 전에는 동작을 바꾸지 말 것.

export interface OrderItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface OrderResult {
  orderId: string;
  total: number;
  status: "CONFIRMED" | "REJECTED";
  reason?: string;
}

const PAYMENT_URL = process.env.PAYMENT_URL ?? "http://127.0.0.1:4242";

// 모듈 전역 상태: 프로세스 수명 동안 모든 호출이 공유한다
export const inventory = new Map<string, number>([
  ["KEYBOARD-01", 20],
  ["MOUSE-01", 50],
  ["MONITOR-01", 5],
]);

export const confirmedOrders: OrderResult[] = [];

export function calcTotal(items: OrderItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.unitPrice * item.quantity;
  }
  return total;
}

export async function confirmOrder(items: OrderItem[]): Promise<OrderResult> {
  // 심야(22시~06시) 주문에는 배송 할증이 붙는다 — 시스템 시계에 직접 의존
  const hour = new Date().getHours();
  const nightSurcharge = hour >= 22 || hour < 6 ? 3_000 : 0;

  const total = calcTotal(items) + nightSurcharge;

  // 재고 확인과 차감이 한 루프에 섞여 있다
  for (const item of items) {
    const stock = inventory.get(item.sku);
    if (stock === undefined) {
      return { orderId: "", total, status: "REJECTED", reason: `unknown sku: ${item.sku}` };
    }
    if (stock < item.quantity) {
      return { orderId: "", total, status: "REJECTED", reason: `out of stock: ${item.sku}` };
    }
    inventory.set(item.sku, stock - item.quantity);
  }

  // 주문 ID가 현재 시각과 난수에 의존한다
  const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1_000)}`;

  // 외부 결제 시스템 직접 호출
  const res = await fetch(`${PAYMENT_URL}/charge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId, amount: total }),
  });

  if (!res.ok) {
    return { orderId, total, status: "REJECTED", reason: `payment failed: ${res.status}` };
  }

  const order: OrderResult = { orderId, total, status: "CONFIRMED" };
  confirmedOrders.push(order);
  return order;
}
