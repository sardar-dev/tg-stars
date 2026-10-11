// Use: npm run probe -- <16-char-unique-code>
// Test purchase ke baad chalao. DigiSeller ka ASAL response print karta hai taake hum exact
// field names (quantity, username option) confirm kar sakein. Ye kuch order/pay NAHI karta.
import { loadConfigForProbe } from "./_cfg.js";
import { makeDigiseller, parseUniqueCode } from "../src/digiseller.js";

const code = process.argv[2];
if (!code) {
  console.error("Usage: npm run probe -- <unique-code>");
  process.exit(1);
}
const cfg = loadConfigForProbe();
const digi = makeDigiseller(cfg.digiseller);
const raw = await digi.verifyUniqueCode(code);

console.log("=== RAW DigiSeller response (buyer email/IP jaisi cheezein share karne se pehle hata dena) ===");
console.log(JSON.stringify(raw, null, 2));
console.log("\n=== Parsed by our code ===");
console.log(parseUniqueCode(raw, cfg.digiseller.usernameOptionId));
console.log("\nAgar quantity ya username khali/undefined hai, to upar RAW mein sahi field ka naam dhoondo aur mujhe batao.");
