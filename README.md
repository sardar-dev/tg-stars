# Telegram Stars auto-delivery: DigiSeller (Plati) → MyStars

Sardar ke liye. Is project ka kaam: Plati/DigiSeller par bike hue Stars ke order ko automatically
MyStars ke zariye buyer ke Telegram username par deliver karna.

> **STATUS (honest):** Code likha gaya hai aur **offline tests (15/15)** pass hain, jo fake DigiSeller/MyStars/wallet par
> logic check karte hain. **Asli DigiSeller + MyStars + on-chain payment ke saath abhi koi test nahi hua.**
> Isliye ise "working" na samjho. Product publish mat karo jab tak neeche ka "Test plan" poora na ho.

---

## 1. Architecture ka jawab (tumhara Task 1 & 2)

### Kya verified hai (official docs se)

| Baat | Source |
|---|---|
| Non-fixed (variable) price product mein buyer ki quantity `unit_cnt` ("quantity of the product with a non-fixed price") se aati hai; aise product par `cnt_lock=1` hota hai, yaani "1 se zyada alag items" nahi kharide ja sakte, quantity sirf `unit_cnt` ke zariye hoti hai | https://my.digiseller.com/inside/api_payment.asp |
| Product par parameters (options, jaise text field) hote hain, aur docs ke FAQ mein variable-price unique-code product ke saath "buyer se game nickname/login poochho" ka misaal hai | https://en.webmoney.wiki/projects/digiseller/wiki/Frequently_Asked_Questions_on_how_to_select_a_product_at_Digiseller |
| "Unique code verification": payment ke baad buyer aapke URL par redirect hota hai, code ke saath; extra parameters bhi aa sakte hain; phir aap DigiSeller API se code verify karke purchase details lete ho | same FAQ |
| Verify API: `GET https://api.digiseller.com/api/purchases/unique-code/{code}?token=...` (16 char code); response mein `retval`, `retdesc`, `inv`, `lang` confirmed | https://my.digiseller.com/inside/api_general.asp |
| Token: `POST https://api.digiseller.com/api/apilogin` with `sign = SHA256(api_key + timestamp)` | same |
| "Form / data received from your server" (Supplier API): DigiSeller aapke URL par POST karta hai `id, inv, amount, type_curr, sign2, options[{id,user_data}]`; aap `goods` return karte ho; agar goods nahi doge to DigiSeller ~3 ghante tak (up to 50 attempts, 10s se 5min interval) dobara bhejta hai; same `inv` par same jawab dena (idempotent) | https://my.digiseller.com/inside/api_supplier.asp |
| Form content ki settings mein `allow_purchase_multiple_items` aur `url_for_quantity` hain | https://my.digiseller.com/inside/api_content.asp |

### Kya verified NAHI hai

1. **Kya "Unique product with variable price" + Form (data from your server) ek saath chal sakte hain?**
   Official docs mein dono alag content types hain aur mujhe kahin likha nahi mila ke inhe milaya ja sakta hai.
   **Isliye ise "mutually exclusive jab tak sabit na ho" maano.** 10-second check: apne product ke
   "Content of item" dropdown mein dekho ke variable-price ke saath "data from your server/Form" ka option aata hai ya nahi.
   Pakka jawab DigiSeller support se bhi poochh sakte ho.
2. Unique-code verify response ke baqi fields (quantity ka naam, buyer options ka shape): docs ka wo hissa mujhe poora nahi mila.
   Code mein `parseUniqueCode()` tolerant hai, aur `npm run probe -- CODE` asli response print karta hai. **Ye test purchase ke baad lock karenge.**
3. "Mark as delivered" API ka exact URL/method: wo section mujhe nahi mila. Isliye `DIGISELLER_DELIVER_URL_TEMPLATE` khali hai
   (step skip hota hai). Docs ke "Change the status of the unique code to goods delivered" (https://my.digiseller.com/inside/api_general.asp#deliveruniquecode) se dekh kar bharo.
4. Docs mein ek **product-parameter check URL** ka zikr mila (DigiSeller payment se *pehle* aapke URL ko options + quantity bhej kar
   validate karta hai, aur aap error text return kar sakte ho). Agar ye confirm ho jaye to Telegram username **checkout ke waqt** hi verify ho sakta hai,
   jo pay ke baad wale failures ko bohot kam kar dega. Maine ye endpoint nahi banaya kyunki iska exact format abhi nahi padha.
   (Reference page: https://my.digiseller.com/inside/api_payment.asp, "options" section.)

### Meri recommendation

**Product type: "Unique product with variable price" + content "Unique code" + ek text option "Telegram username" + "automatic code verification" URL.**
Wajah: ye wohi configuration hai jisme tumhari saari requirements (50–1,000,000 integer quantity, automatic price, buyer ka username) ke liye documented hissay maujood hain.

**Is design ka sabse bada risk:** trigger buyer ke browser ka redirect hai. Agar buyer payment ke baad tab band kar de, to `/delivery` hit nahi hota
aur kuch trigger nahi hota. Mitigations: (a) test mein dekhna ke redirect automatic hai, (b) alert/"missed order" script (DigiSeller sales list se paid-but-unprocessed invoices pakadna) - ye tab banega jab
asli response fields dekh lein, (c) Supplier-API (Form) path: server-to-server hai, buyer par depend nahi karta, par documented request mein **quantity ka field nahi hai** - isliye variable quantity ke liye
usse bina DigiSeller se confirm kiye use nahi kiya.

---

## 2. Backend kyun chahiye (beginner explanation)

DigiSeller sirf payment leta hai. Stars bhejne ke liye kisi ko (1) DigiSeller se pooch kar confirm karna hai ke payment asli hai, (2) MyStars se order banana hai,
(3) **on-chain payment bhejni hai** (MyStars mein prepaid balance nahi hota, har order ki apni crypto payment hoti hai: https://mystars.tg/developers FAQ), (4) delivery confirm karni hai.
Ye sab ek chalta hua server karta hai. Isliye **Vercel/Netlify jaise serverless hosting theek nahi** (background polling, wallet, database state chahiye). **Railway** (tum pehle use kar chuke ho), Render, Fly.io ya VPS theek hain.

### Endpoints (sirf 3 chahiye)

| Endpoint | Kaun call karta hai | Kaam |
|---|---|---|
| `GET /delivery?uniquecode=...` | DigiSeller (buyer ko redirect karke) | **Yahi URL DigiSeller mein daalna hai.** Code verify, order banana, buyer ko status page dikhana (auto-refresh) |
| `POST /webhooks/mystars` | MyStars | Signed webhook (X-Faas-Signature, HMAC-SHA256 raw body). Optional: bina iske polling chalti rehti hai |
| `GET /health` | Railway | Health check |

Aur background mein ek **sweeper** (har 30s) jo pending orders poll karta hai, crash ke baad recover karta hai, aur wallet balance monitor karta hai.

### Poora flow

```
Buyer Plati par quantity + @username chun kar pay karta hai
  → DigiSeller buyer ko  https://YOUR-DOMAIN/delivery?uniquecode=XXXXXXXXXXXXXXXX  par bhejta hai
  → hum DigiSeller API se code verify karte hain  (inv, quantity, username milta hai)
  → DB mein order (inv primary key = duplicate protection)
  → validation: quantity 50..1,000,000, username format, safety limits
  → MyStars recipient check (payment se pehle)
  → MyStars createOrder  (Idempotency-Key = digi-<inv>-<attempt>)
  → DB mein 'paying' save karke  → wallet se on-chain payment (ek waqt mein ek)
  → MyStars Fragment se Stars deliver karta hai
  → webhook ya polling se 'delivered' → DB 'delivered' → DigiSeller ko "delivered" mark → buyer page par success
```

Order states: `queued → processing → paying → paid_waiting → delivered`, ya `failed` / `needs_review`.

### Failure/duplicate handling (jo tests verify karte hain)

* Same code ya same invoice dobara aaye (refresh, double click, concurrent) → payment sirf **ek** baar.
* Payment ke dauraan crash → restart par **dobara pay nahi hota**; `needs_review` + alert (double-spend se bachao).
* Unknown payment error → khud retry nahi; alert. (Payment broadcast ho chuki ho sakti hai.)
* Wallet mein balance kam → MyStars order cancel, order queue mein, naye idempotency key se baad mein dobara; alert.
* Galat/na-mumkin username ya out-of-range quantity → buyer pay kar chuka hota hai, isliye order `needs_review` mein record hota hai + alert (username theek karo ya DigiSeller se refund). **Ye yaad rakho: refund automatic nahi hai.**
* `MAX_STARS_AUTO` se bade orders khud pay nahi hote (manual approval). `MAX_STARS_PER_DAY` daily limit.
* MyStars `failed/reversed/expired` → order `failed` + alert. MyStars paise wapas wallet mein bhejta hai (docs: "Reversals & delivery"), buyer ka refund tumhe DigiSeller mein karna hoga.

---

## 3. Verified MyStars workflow (https://mystars.tg/openapi.json v2.0.0, https://mystars.tg/docs, https://mystars.tg/developers)

* Auth: `X-Api-Key` header. Key `@my_stars_tg_bot → API access` se; **rotate: bot mein `/api_rotate`**.
* Quote: `GET /v1/pricing?type=stars&quantity=N&payment_currency=ton|usdt_ton` → all-in `amount`. **`payment_currency` ab zaroori hai** (v2.0.0, koi default nahi). `ton` = GRAM (USDT nahi!). Quote sirf hint hai (`valid_until`); price order create par lock hota hai.
* Recipient check: `POST /v1/recipients/check`. `indeterminate: true` = "pata nahi" (eligible default hai), order create khud dobara check karta hai (ineligible → `422 recipient_ineligible`, koi order/charge nahi).
* Create: `POST /v1/orders` + **zaroori** `Idempotency-Key`. Same key + same body = same order; alag body = 409.
* Payment: order `awaiting_payment` mein aata hai, `payment` block mein `pay_to_address`, `memo` (= order id), exact `amount`, `asset` (GRAM/USDT), `transfer` (native/jetton). **Galat asset/memo/amount par payment reverse hoti hai.** Payment window `expires_at` se (changelog: 2 ghante).
* **Prepaid balance nahi.** Har order apni on-chain payment se settle hota hai (non-custodial).
* Status: `received, awaiting_payment, paid, reserved, swapping, funding, purchasing, fulfilling, completed, delivered, failed, reversed, expired, held, cancelled`. Final: `delivered/failed/reversed/expired`.
* Webhook: `X-Faas-Signature` = hex HMAC-SHA256(raw body, secret); rotation ke dauran comma-separated list; 5 second mein 2xx do; `callback_url` public https honi chahiye; retries hain. Payload chhota hai: `order_id, status, failure_reason, purchase_tx, reversal_tx`.
* Rate limits: pricing/recipient-check par 60/min; baqi per-minute budget, daily order cap aur per-recipient guard hain (**numbers spec mein nahi hain**).
* Wallet SDK (`@mystars-tg/faas-wallet`): keys sirf memory mein; `TonWallet` WalletContractV4 banata hai; `OrderPayer.payOrder` sign + broadcast karta hai.

**Verified nahi:** webhook secret kahan se aata/kaise rotate hota hai (spec "rotate your webhook secret" kehta hai par tareeqa nahi); MyStars ki reputation/uptime (sirf unka apna marketing page padha).

---

## 4. Setup (beginner steps)

### Step 0 — pehle credentials rotate karo
* MyStars API key (jo chat mein expose hui): `@my_stars_tg_bot` mein `/api_rotate`. Webhook secret bhi naya lo.
* DigiSeller API key: agar kabhi expose hui to https://my.digiseller.com/inside/api_keys.asp se nayi banao.
* Kisi bhi key/mnemonic ko chat, GitHub, ya frontend code mein kabhi mat daalo.

### Step 1 — local setup
```bash
npm install
cp .env.example .env      # phir .env mein apni nayi values bharo
npm test                  # offline tests, 15 pass hone chahiye
npm run wallet:new        # NAYA alag hot wallet. Mnemonic password manager mein, address par thode paise bhejo
```
Hot wallet mein sirf kuch orders jitna balance rakho. USDT order ke liye thoda GRAM bhi chahiye (gas).

### Step 2 — pricing (Task 7)
```bash
npm run price
```
Ye **live MyStars quote** se cost nikalta hai (main ne koi price invent nahi ki). Tumhe ye env dena hota hai:
`PLATFORM_FEE_PCT` (Plati/DigiSeller commission - apne seller account ke fees/tariff page se dekho), `PAYOUT_FEE_PCT` (withdrawal/conversion cost),
`MARGIN_PCT`, optional `FIXED_COST_USD`, aur `PAYMENT_CURRENCY`.
Formula: `price = (cost × (1 + margin) + fixed) / (1 − platform_fee − payout_fee)`.
DigiSeller variable product mein ek hi per-unit price (4 decimals) hoti hai, isliye table ki sabse unchi per-star price (jo quantity range tum bechoge) + buffer lo, kyunki rate badalta rehta hai.
GRAM mein pay karo to GRAM→USD rate (`GRAM_USD`) ka asar bhi hota hai; USDT mein pay karna price ko stable rakhta hai (par isme MyStars ek processing fee quote mein jodta hai).
Is README ke ya mere paas **Plati ki current commission % nahi hai** (official page nahi mili) - apne account se dekh kar daalo.

### Step 3 — deploy (Railway)
1. Code ko **private** GitHub repo mein push karo (`.env` aur `node_modules` `.gitignore` mein hain).
2. Railway → New Project → Deploy from GitHub repo.
3. **Volume** banao aur `/data` par mount karo (SQLite DB yahin rahegi; bina volume ke redeploy par orders ka record ud jayega). `DB_PATH=/data/orders.db`.
4. Variables tab mein `.env.example` ki saari values (asli secrets ke saath) daalo.
5. Settings → Networking → Generate Domain. Phir `PUBLIC_BASE_URL=https://<wo-domain>` set karo aur redeploy.
6. Health check path `/health`. **Sirf 1 instance chalao** (SQLite + payment lock ek hi process mein hain; 2 replicas = risk).
7. Logs mein "wallet ready" line dekho aur wo address fund karo.
(Railway UI ke naam badal sakte hain; ye steps meri general jaankari se hain, abhi test nahi kiye.)

### Step 4 — DigiSeller mein kya daalna hai
**Automatic verification URL:** `https://<tumhara-domain>/delivery`
DigiSeller isme `?uniquecode=...` khud jodta hai. Ek asli test purchase (competitor ke listing se) ka redirect aisa tha:
`https://<seller>/digisellerorders?uniquecode=&uniquecode=XXXXXXXXXXXXXXXX&pay_uid=<uuid>` - yaani `uniquecode` **do baar** (pehla khali) aur ek extra `pay_uid`.
Hamara `src/params.js` isi shape ko handle karta hai (test mein verified). Order number jo buyer ko dikhta hai wohi DigiSeller ka invoice number (`inv`) hai.
Product mein ek **text parameter "Telegram username"** banao (required). Quantity min 50, max 1,000,000, integer-only. `https://api.mystars.tg/v1` DigiSeller mein **nahi** daalna.

---

## 4b. Live test apne computer par (DigiSeller ke BAGHAIR) - pehle ye karo

Ye script sirf MyStars + wallet payment + Stars delivery test karta hai (DigiSeller wala hissa nahi). Wallet seed aur API key tumhare computer par hi rehti hain.

1. Node 22+ install karo, repo clone karo, `npm install`.
2. Dummy wallet: `npm run wallet:new` (naya address + 24 words). Address par paise bhejo.
   * Sabse aasan: **sirf GRAM** bhejo aur `PAYMENT_CURRENCY=ton` rakho (gas usi balance se).
   * USDT (`usdt_ton`) mein pay karna ho to USDT ke saath **thoda GRAM bhi** chahiye (gas, ~0.1 estimate). MyStars USDT quote mein processing fee bhi jodta hai, isliye 50 Stars ka quote tumhari soch se thoda zyada ho sakta hai - dry run ye dikha dega.
3. `.env` (copy of `.env.example`) mein bharo: `MYSTARS_API_KEY` (nayi, rotated), `WALLET_MNEMONIC`, `PAYMENT_CURRENCY`, `TEST_USERNAME`, `MAX_PAY` (is se zyada kabhi pay nahi karega).
4. `npm run e2e` -> DRY RUN: wallet address, balance, live quote, username check. Kuch kharidta nahi.
5. Sab theek ho to `npm run e2e -- --pay` -> order banata hai, pay karta hai, delivery ka intezaar karta hai.
6. Telegram mein khud dekho ke Stars aaye. Tabhi test pass maano.
Dobara chalane par wahi idempotency key use hoti hai, isliye adhoora test dobara pay nahi karta (`data/e2e-last.json`, ye file GitHub par nahi jati).

## 5. Test plan (publish se PEHLE; Task 8)

Product ko **publish/visible mat karo** jab tak sab pass na ho (self-purchase/hidden-product testing DigiSeller mein kaise hota hai - ye maine verify nahi kiya; apna product-visibility setting dekho ya doosre account se kharido).

1. `npm test` → 15/15 (offline logic).
2. `npm run price` → live quote aata hai? (MyStars key + connectivity check.)
3. Deploy ke baad `https://<domain>/health` → `{"ok":true}`.
4. Env mein `MAX_STARS_AUTO=100`, `MAX_STARS_PER_DAY=300`. Wallet mein sirf kuch order jitna balance.
5. **Test order #1: 50 Stars** (minimum), apne **doosre Telegram account** ke username par.
   * Pehli baar parse fail ho sakta hai (field names unverified). Safe hai: order `needs_review` mein jayega, payment nahi hogi.
     Phir local par `npm run probe -- <unique-code>` chalao aur output (email/IP hata kar) mujhe bhejo; main field names lock kar dunga.
6. Verify karo, **sab ek ek karke**:
   * buyer page "delivered" dikhata hai,
   * Telegram account mein **Stars asli mein aaye** (Telegram ke Stars balance/transactions mein),
   * MyStars order `delivered` hai aur `purchase_tx` hai (`npm run orders` ya MyStars bot),
   * DigiSeller side par order "delivered" mark hua (jab deliver URL set ho),
   * wallet se utna hi gaya jitna quote tha.
7. **Failure drills:** (a) nonexistent username → `needs_review` + alert, koi payment nahi; (b) wallet khali karke order → alert + queued, top-up par khud poora; (c) server restart order ke beech → dobara pay nahi hota; (d) `/delivery` page 3 baar refresh → ek hi payment.
8. Redirect test: payment ke baad **tab band** kar ke dekho kya hota hai (missed-order risk). Agar order trigger nahi hota to "missed order" recovery script pehle banao.
9. Phir hi publish karo, shuru mein limits chhote rakho aur pehle kuch din har order khud dekho.

---

## 6. Files

```
src/server.js     HTTP server, /delivery, /webhooks/mystars, /health, sweeper, balance monitor
src/engine.js     poori state machine (duplicate/crash/retry logic)
src/digiseller.js DigiSeller token + unique-code verify + parser (UNVERIFIED field names yahan hain)
src/mystars.js    MyStars client + wallet payer
src/db.js         SQLite (orders table)
src/pages.js      buyer ko dikhne wale EN/RU pages
src/notify.js     Telegram alerts
scripts/          probe-unique-code, price, new-wallet, list-orders
test/             offline tests
```

## 7. Jo abhi baqi hai (honest list)

* Asli DigiSeller response ke fields confirm (probe).
* "Mark delivered" URL confirm.
* Checkout-time username validation (DigiSeller options-check URL) - format padhna baqi.
* Missed-redirect recovery.
* Asli end-to-end test (Test plan).
* Plati commission ka official figure.
