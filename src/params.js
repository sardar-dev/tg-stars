// DigiSeller redirect mein `uniquecode` kabhi do baar aata hai, pehla khali. Asli example (test purchase):
//   ...?uniquecode=&uniquecode=XXXXXXXXXXXXXXXX&pay_uid=<uuid>
// Express ise array ["", "XXXXXXXXXXXXXXXX"] bana deta hai. Hum saari values dekh kar
// pehla valid 16-character code uthate hain. (`pay_uid` ko abhi ignore karte hain.)
const CODE_RE = /^[A-Za-z0-9]{16}$/;

export function pickUniqueCode(query = {}) {
  const values = [query.uniquecode, query.uniqueCode, query.unique_code].flat();
  for (const v of values) {
    if (typeof v === "string" && CODE_RE.test(v.trim())) return v.trim();
  }
  return null;
}
