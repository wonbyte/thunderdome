// The shop page: a sample order with the code SAVE10, priced by checkout().
import { checkout, formatPrice, type CartLine } from "./checkout.ts";

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c2333;background:#f4f1ea}
h1{margin:0;padding:18px 28px;font-size:22px;letter-spacing:.02em;color:#fff;background:linear-gradient(90deg,#1d2440,#3a2f6b)}
h2{margin:20px 28px 10px;font-size:16px}
table{margin:0 28px 28px;min-width:320px;border-collapse:collapse;border:1px solid #e6e0d4;background:#fff;font-variant-numeric:tabular-nums}
td{padding:8px 14px}
td+td{text-align:right}
tr+tr{border-top:1px solid #efeae0}
@media (max-width:520px) {
  h1{padding:14px 16px}
  h2{margin:16px 16px 10px}
  table{margin:0 16px 20px;min-width:0;width:calc(100% - 32px)}
}
`;

// The order shown on the home page.
export const SAMPLE_ORDER: CartLine[] = [{ title: "Judge Notebook", cents: 2600, qty: 2 }];
export const SAMPLE_CODE = "SAVE10";

export function renderPage(lines: CartLine[], code: string): string {
  const totals = checkout(lines, code);
  const rows = lines.map((line) => `<tr><td>${line.title} × ${line.qty}</td><td>${formatPrice(line.cents * line.qty)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thunderdome Shop</title><style>${STYLE}</style></head>
<body>
<h1>Thunderdome Shop</h1>
<h2>Your order</h2>
<table>
${rows}
<tr><td>Subtotal</td><td id="subtotal">${formatPrice(totals.subtotal)}</td></tr>
<tr><td>${code}</td><td id="discount">-${formatPrice(totals.discount)}</td></tr>
<tr><td>Shipping</td><td id="shipping">${formatPrice(totals.shipping)}</td></tr>
<tr><td>Total</td><td id="total">${formatPrice(totals.total)}</td></tr>
</table>
</body>
</html>`;
}

export default {
  async fetch(): Promise<Response> {
    return new Response(renderPage(SAMPLE_ORDER, SAMPLE_CODE), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
