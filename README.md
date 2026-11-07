# Aslan Omni Payment — Odoo POS integration

An **Odoo 20 Point of Sale** add-on that turns an **Aslan Omni card terminal**
into a payment method inside Odoo. When a cashier rings up an order and chooses
"Aslan Omni", Odoo tells the terminal (over the Aslan cloud) how much to charge;
the customer taps or inserts their card on the terminal; the result (approved /
declined) flows back into Odoo, and the card slips (customer copy on the order
receipt, merchant copy as a separate cut) print from it.

**If you have never touched this code before, read this file top to bottom
before changing anything.** It is written to teach, not just describe: every
section explains *why* the code is shaped the way it is, especially around the
parts that touch money or credentials. Skipping to "the file I need to edit"
is how the original double-charge bug (§8.1) got introduced — read the money
rules first.

---

## Table of contents

1. [The one-paragraph mental model](#1-the-one-paragraph-mental-model)
2. [Who talks to whom (architecture)](#2-who-talks-to-whom-architecture)
3. [What a payment actually looks like, step by step](#3-what-a-payment-actually-looks-like-step-by-step)
4. [Installation](#4-installation)
5. [Pairing a terminal (one-time setup per payment method)](#5-pairing-a-terminal-one-time-setup-per-payment-method)
6. [Taking a payment (the cashier's view)](#6-taking-a-payment-the-cashiers-view)
7. [Reversing (voiding) a payment](#7-reversing-voiding-a-payment)
8. [The money-safety rules (READ THIS before editing payment code)](#8-the-money-safety-rules-read-this-before-editing-payment-code)
9. [The files, one by one](#9-the-files-one-by-one)
10. [Where Odoo 20 bends this add-on's design (read if you're new to Odoo POS internals)](#10-where-odoo-20-bends-this-add-ons-design-read-if-youre-new-to-odoo-pos-internals)
11. [The server API this add-on calls](#11-the-server-api-this-add-on-calls)
12. [Security model](#12-security-model)
13. [Troubleshooting](#13-troubleshooting)
14. [Known limitations](#14-known-limitations)
15. [Glossary](#15-glossary)

---

## 1. The one-paragraph mental model

Odoo POS runs **in the cashier's browser**. The Omni terminal is a **separate
physical device** that may be across the counter or in another room. They never
talk directly. Instead, the POS asks the **Odoo server** to send an HTTPS
request to the **Aslan Omni cloud API** (the merchant API key stays on the
server and never reaches the browser), and the cloud **relays** the command to
the terminal over a live connection (Server-Sent Events). The terminal reads the
card, then posts the result back up to the cloud; the POS polls the command's
status until it resolves. After an approval the POS prints the card slips: the
customer copy at the bottom of the order receipt, the merchant copy as its own
slip. Everything in this add-on is a thin client around five cloud endpoints:
**pair**, **pay**, **reverse**, **status**, and **revoke**.

---

## 2. Who talks to whom (architecture)

```
┌─────────────────┐  ORM RPC   ┌──────────────────┐   HTTPS    ┌───────────────────┐  SSE relay  ┌──────────────────┐
│ Odoo POS        │ ─────────▶ │ Odoo server      │ ─────────▶ │ Aslan Omni API    │ ──────────▶ │ Omni terminal    │
│ (browser)       │            │ pos.payment.     │ /cloud/pay │ (cloud relay)     │ "PayCommand"│ (Sunmi device)   │
│ = this add-on   │ ◀───────── │ method           │ wait:false │                   │ ◀────────── │                  │
│                 │ {httpStatus│ holds the API key│ ◀───────── │ - answers 202 +   │ card result │ - reads card     │
│ - payment iface │  , body}   │ (Bearer +        │ 202        │   commandId       │             │ - NapsPay auth   │
│ - receipt block │            │ X-Device-Id)     │ then GET   │ - stores command  │             └──────────────────┘
│ - card slips    │ polls every└──────────────────┘ .../status │   by `ref`        │
└─────────────────┘ 3 s                                        │   (idempotent)    │
                                                               └───────────────────┘
```

(The backend pairing widget is the one exception: it runs in the manager's
browser and calls `/cloud/pair` and `/cloud/devices/:deviceId/revoke` directly —
see [§11](#11-the-server-api-this-add-on-calls).)

Key facts that shape everything else:

- **POS → Odoo server → cloud.** The browser never calls the Omni API. It calls
  three server methods on `pos.payment.method` (`aslan_omni_send_payment`,
  `aslan_omni_send_reversal`, `aslan_omni_command_status`), which make the HTTPS
  request server-side with a 15 s timeout. Pay and reverse are sent with
  `wait: false`, so the cloud answers `202 + commandId` as soon as the command is
  relayed, instead of holding the request open. The POS then **polls the
  command's status** every 3 s for up to **97 s** (a 2-second buffer over the
  server's 95 s command TTL) while the customer fumbles for their card.
- **Cloud → terminal is a live push (SSE).** The terminal keeps a streaming
  connection open to the cloud; the cloud pushes it a `PayCommand`. This add-on
  never talks to the terminal directly, so it does not need to be on the same
  Wi-Fi as the terminal.
- **The terminal, not Odoo, owns the card interaction.** Once the command is
  sent, only the terminal (or its 95 s timeout) can finish or abort it. Odoo is
  a bystander waiting for the answer. This single fact is why cancellation and
  retries work the way they do — see [section 8](#8-the-money-safety-rules-read-this-before-editing-payment-code).

---

## 3. What a payment actually looks like, step by step

The happy path and the three failure paths, drawn out:

### Happy path

```
Cashier clicks "Charge"
   │
   ▼
POS → Odoo server: aslan_omni_send_payment(ref, amountCents, ...)   ◀── ref = "ODOO-<line.uuid without dashes>"  (STABLE, see §8)
   │                                                                     amountCents = line amount × 100
   ▼
Odoo server → POST /cloud/pay { ref, amountCents, ..., wait: false }
Cloud stores the command keyed by `ref`, pushes "PayCommand" to the terminal,
and answers at once: 202 { commandId, status: "pending" }.
   │
   ▼
POS polls aslan_omni_command_status(commandId) every 3 s → GET /cloud/pay/:commandId/status
   │
   ▼
Customer taps card → terminal authorises via NapsPay → terminal POSTs result to cloud
   │
   ▼
Status turns { status: "completed", resultStatus: "approved", cardScheme, authNumber, stan, rrn, ... }
   │
   ▼
Odoo: payment line → "done", stores masked card details in line.uiState for the card slips.  ✅
```

### Failure path A — terminal not connected

The cloud answers `503` immediately (passed through by the Odoo server). Odoo shows *"Terminal non connecté"* and
lets the cashier retry. No card was read, no money moved.

### Failure path B — customer never presents a card

After 95 s the command's status turns to `timeout` (a direct `408` is also
handled). Odoo shows *"Délai expiré"*. No money moved.

### Failure path C — the internet drops mid-payment (the important one)

This is where the design earns its keep. The call to the Odoo server (or the
Odoo server's call to the cloud) dies with a network error — but the terminal
may still be reading the card, and the cloud may have already recorded (or
completed) the command. The add-on does **not** give up. It **sends
`aslan_omni_send_payment` again with the exact same `ref`** (waiting 3 s between
tries), up to `MAX_RECOVERY_ATTEMPTS` (2) re-sends after the first. Because the
ref is stable, the server recognises it and:

- if the command already **completed** → returns the real result (we show
  approved/declined — correct, no double charge);
- if it is still **pending** → returns `409 + commandId`, and we switch to
  polling the command's status until it resolves;
- if a prior attempt **timed out** → the server safely re-relays the same ref.

In every branch the customer's card is charged **at most once**. See
[section 8](#8-the-money-safety-rules-read-this-before-editing-payment-code) for
why the stable ref is load-bearing here.

---

## 4. Installation

**Prerequisites:** Odoo **20.0**, the `point_of_sale` module, and an Aslan Omni
terminal that can reach the cloud API.

> This add-on targets Odoo 20.0 specifically — it uses the 20.0 POS JavaScript
> architecture (`pos_payment_providers` registry, `pos.payment.method`-based
> terminal config, `line.uiState`). It will **not** install cleanly on Odoo
> 16/17/18/19; see [section 10](#10-where-odoo-20-bends-this-add-ons-design-read-if-youre-new-to-odoo-pos-internals)
> if you need to understand why, or [Known limitations](#14-known-limitations)
> if you need an older version.

1. Copy this folder into your Odoo add-ons path, named exactly
   **`aslan_omni_payment`** (the folder name is the technical module name that
   every asset path depends on):

   ```
   <your-addons-path>/aslan_omni_payment/
   ```

2. Restart Odoo and update the apps list (Settings → *Activate developer mode* →
   Apps → *Update Apps List*).

3. Install **"Aslan Omni Payment"** from the Apps menu.

Unlike most payment-terminal add-ons, this one does **not** auto-create a
payment method for you (see the note at the end of
[section 5](#5-pairing-a-terminal-one-time-setup-per-payment-method) for why).
After installing, go create one:

4. **Point of Sale → Configuration → Payment Methods → New.**
   - Give it a name (e.g. "Aslan Omni").
   - Set **Type** to `Bank`.
   - Pick a **Journal** (a bank journal for your company — required by Odoo
     for any non-cash payment method).
   - Set **Use a Payment Terminal** to **Aslan Omni**. An **Aslan Omni**
     settings page appears in the same form.
   - Add this payment method to your Point of Sale's configuration
     (**Point of Sale → Configuration → Point of Sale → Payment Methods**).

> **Module name matters.** The manifest wires JS/XML assets under
> `aslan_omni_payment/static/...` and registers the payment interface under the
> key `aslan_omni`, which must match the `payment_provider` selection value
> declared in `models/pos_payment_method.py`. If you rename the folder, the
> asset paths break; if you rename the key in one place without the other, the
> terminal silently never activates. Keep the folder named `aslan_omni_payment`.

---

## 5. Pairing a terminal (one-time setup per payment method)

Pairing exchanges a short code shown on the terminal for a **merchant API key**
that Odoo stores and the Odoo server sends on every future request. You do this once per
payment method (most shops only need one).

1. Open the payment method you created above (**Point of Sale → Configuration
   → Payment Methods**), with **Use a Payment Terminal = Aslan Omni**. Open the
   **Aslan Omni** tab on the form.
2. Confirm the **Aslan Omni API URL** (defaults to `https://api.aslanpay.ma`).
   It **must** be `https://` — the add-on refuses anything else (credentials
   travel on this URL).
3. On the **terminal**, start pairing ("Associer avec Odoo"). It shows an
   **8-character code** (valid for 120 seconds).
4. Type that code into the pairing widget in Odoo and click **Associer**.
5. On success the widget shows ✅ *Terminal associé* with the Device ID, and
   Odoo has silently stored the **Device ID** and the **API Key** on this
   payment method record.
6. Optionally, untick **Print merchant card receipt** (on the same tab). It is
   on by default; see [Card slips](#card-slips-and-the-print-merchant-card-receipt-setting).

Under the hood: the widget calls `POST /cloud/pair { pairingCode }`; the server
returns `{ deviceId, apiKey, merchantId, merchantName }`; the widget writes
`aslan_omni_device_id` and `aslan_omni_api_key` onto the `pos.payment.method`
record via `this.orm.write(...)`.

**Re-associate / Dissociate.** The ✅ panel offers both. *Dissocier* calls
`POST /cloud/devices/:deviceId/revoke` (best effort) and **always** clears the
local key and device id afterwards, even if that network call fails — so a
revoke can never leave a dead key behind in Odoo.

### Card slips and the "Print merchant card receipt" setting

The **Aslan Omni** tab has a **Print merchant card receipt**
(`aslan_omni_print_merchant_receipt`, Boolean, default **on**) checkbox. It
controls the merchant copy of the card slip ("Copie commerçant - A conserver"):

- Unticked, the merchant copy is not printed, on either print path (receipt
  printer or browser printing). The customer copy ("Copie client", appended to
  the order receipt) is unaffected.
- It is a per-payment-method setting, loaded with the POS data: **open POS
  sessions must be closed and reopened** to pick up a change.
- In the Odoo flow the terminal itself never prints (the cloud path does not ask
  the terminal for its own receipt), so this setting controls the only merchant
  slip there is.

> **Why there is no pre-installed "Aslan Omni" payment method record.** Earlier
> versions of this add-on shipped a data file that auto-created one. That
> turned out to be the wrong default: every `pos.payment.method` needs a
> **company-specific** `journal_id`, which the module cannot know in advance
> for every installation. No core Odoo terminal-provider add-on (Stripe,
> Adyen, Viva Wallet, …) ships a pre-created payment method either — they all
> expect the integrator to create it by hand, as step 4 above does. This is
> normal Odoo practice, not a missing feature.

---

## 6. Taking a payment (the cashier's view)

1. Build the order in POS as usual.
2. At payment, choose **Aslan Omni** and click **Charge** (or enter a partial
   amount first — the terminal is told exactly the line amount).
3. Odoo shows *"waiting for card"*; the terminal lights up and asks for the card.
4. The customer taps / inserts / swipes. On approval the line turns green and the
   card slips print with the receipt:
   - **Customer copy** — "PAIEMENT PAR CARTE" block appended to the order
     receipt, signed "Copie client".
   - **Merchant copy** ("Copie commerçant - A conserver") — on a receipt
     printer, a separate print job right after the order receipt, so the
     printer cuts between them; with browser printing, its own page at the end
     of the same print document. Printed **once per payment line**: reprinting
     the receipt does not repeat it. Skipped when **Print merchant card
     receipt** is off on the payment method (§5).

   Both copies use one template, `aslan_omni_payment.card_slip_body`: company,
   date/time, "PAIEMENT PAR CARTE", scheme + masked card, N° Commerçant,
   N° Terminal, N° Autorisation, N° STAN, RRN, N° Transaction, Commande and the
   amount. A row appears only when its value is present. N° Commerçant,
   N° Terminal and N° Transaction come from the API fields `acquirerMerchantId`,
   `acquirerTerminalId` and `transactionNumber`, and only print with an Omni API
   and terminal app version that send them; otherwise those rows are omitted.

If the cashier clicks **Cancel** while waiting: read
[section 8.3](#83-cancel-does-not-stop-the-terminal) — this is a POS-UI reset
only; it does **not** stop the terminal.

---

## 7. Reversing (voiding) a payment

From a paid order, Odoo's **Reverse** action calls `sendReversal(line)`, which
calls the server method `aslan_omni_send_reversal`, which issues
`POST /cloud/reverse` (with `wait: false`; the POS then polls the status like a
payment). A reversal needs the original transaction's
**STAN** (System Trace Audit Number), which was saved in `line.uiState.aslanOmniResult`
at approval time. If the STAN is missing, the reversal is refused with a clear
message rather than sending a malformed void.

Like a payment, a reversal is a relayed command, and its own `ref`
(`REV-<original-ref>`) is **stable**, so a dropped reversal can be retried safely
without issuing a second void.

---

## 8. The money-safety rules (READ THIS before editing payment code)

Three rules keep this integration from double-charging. They are subtle, and the
code enforces them in ways that look optional but are not. If you change the
payment flow, keep all three true.

### 8.1 The `ref` is a STABLE idempotency key — never put a timestamp in it

The server keys its **entire** deduplication and recovery logic on `ref`
(`omniPendingCommand.ref` is a unique column). Re-sending the **same** ref is how
the server knows "this is the same payment, don't start a second card read — give
me back the existing result."

This add-on builds the ref in **one** place, `_payRef()`, in
`static/src/app/payment_aslan_omni.js`:

```js
_payRef(line) {
    return `ODOO-${line.uuid.replace(/-/g, '')}`;   // 'ODOO-' + 32 hex chars = 37
}
```

`line.uuid` is Odoo's stable, globally-unique client id (uuidv4) for that
payment line — it does not change between retries, so one physical payment
line always maps to exactly one ref. A reversal's own ref is derived the same
way but independently (`REV-${line.uuid...}`, not `REV-` + the pay ref) —
see the note on `sendReversal` below for why.

> ⚠️ **The original bug this replaced:** the ref used to be
> `ODOO-${order.uid}-${Date.now()}`. Because `Date.now()` changes on every
> attempt, every retry produced a *new* ref → a *new* server command → the
> server's dedup could not link them → a retry after a lost response could read
> a **second** card and charge twice. Never reintroduce a changing value here.

> ⚠️ **A second bug found during live staging testing:** `_payRef` briefly
> joined both the order's uuid *and* the line's uuid (`ODOO-<36 chars>-<36
> chars>` ≈ 78 chars). `aslan-omni-api`'s schema caps `ref`/`originalRef` at
> **40 characters** (`z.string().max(40)`), so every real payment attempt was
> silently rejected with a `400` once it actually reached the server — a
> failure the earlier Docker-based verification never caught, since it only
> checked that the module installed and the asset bundles compiled, not that
> a real payment payload satisfied the server's own validation. Since
> `line.uuid` alone is already globally unique, there's no need to fold in
> the order's uuid too — stripping its dashes keeps the ref under the cap
> (37 chars) with no hashing needed.

### 8.2 On any failure before a known result, RE-POST the same ref — do not give up

When the network drops mid-payment, we do **not** know whether the charge
happened. The only safe move is to ask the server, and the server's answer to
"send the same ref again" is exactly the recovery we need (completed → result,
pending → 409+poll, timed-out → re-relay). The payment loop in
`sendPaymentRequest` does this automatically, bounded by `MAX_RECOVERY_ATTEMPTS`.

> ⚠️ **The original bug this replaced:** the old code only polled if it *already*
> had a `commandId`, which it only learned *after* the first response parsed. A
> drop *during* the initial request (the most common failure) left
> `commandId === null`, so it gave up — blind to a charge that may have
> succeeded. The re-POST-same-ref approach does not depend on having a commandId.

### 8.3 Cancel does NOT stop the terminal

There is **no server-side abort endpoint.** Once `/cloud/pay` has relayed the
command, only the terminal (its back button, or its own timeout) can stop the
card read. `sendPaymentCancel` therefore resets the Odoo UI **and warns the
cashier** to also cancel on the terminal if it is still asking for a card.

This is safe against double-charging **only because of rule 8.1**: if the cashier
re-charges the same line after a cosmetic cancel, the stable ref makes the server
re-attach to the existing command instead of starting a new card read. Removing
the stable ref would silently reopen this hole. (A true remote-abort would
require a new terminal-protocol message in `aslan-omni-api`; it does not exist
yet — see [Known limitations](#14-known-limitations).)

---

## 9. The files, one by one

| File | What it does |
|------|--------------|
| `__manifest__.py` | Odoo module descriptor. Declares the dependency on `point_of_sale`, loads the views and the two receipt templates, and splits front-end assets across **three** bundles — see [§10](#10-where-odoo-20-bends-this-add-ons-design-read-if-youre-new-to-odoo-pos-internals) for why there are three, not one. Version `1.1.1` (deliberately **not** prefixed with an Odoo series — see the note under §10), LGPL-3. |
| `models/pos_payment_method.py` | Extends `pos.payment.method` (not `pos.config` — see §10). Adds `aslan_omni_device_id`, `aslan_omni_api_key` (group-restricted, never sent to the POS — see §12), `aslan_omni_api_url` (HTTPS-only via `@api.constrains`) and `aslan_omni_print_merchant_receipt`, registers `'aslan_omni'` in `_get_terminal_provider_selection()`, and pushes **only** `aslan_omni_device_id` and `aslan_omni_print_merchant_receipt` to the POS client via `_load_pos_data_fields`. Also holds the server methods the POS calls — `aslan_omni_send_payment`, `aslan_omni_send_reversal`, `aslan_omni_command_status` — all built on `_aslan_omni_request`, which makes the Omni API call with the key. `aslan_omni_pair_widget` is a non-stored dummy field that exists only as a mount point for the Owl pairing widget. |
| `models/ir_ui_view.py` | Extends `ir.ui.view._get_xml_ids_to_load()` so the card slip templates (`aslan_omni_payment.card_slip_body` and `aslan_omni_payment.card_slip`) are shipped to the POS client, which renders them. |
| `views/pos_payment_method_views.xml` | Adds the **Aslan Omni** notebook page to the standard `pos.payment.method` form (`point_of_sale.pos_payment_method_view_form`): API URL field, read-only Device ID and API Key, the **Print merchant card receipt** checkbox, and the pairing widget. The page is shown only when `payment_provider == 'aslan_omni'`. |
| `static/src/app/payment_aslan_omni.js` | **The core.** Subclass of `PaymentInterface`. Implements `sendPaymentRequest` (pay + recovery loop), `sendPaymentCancel` (UI-only reset + warning), `sendReversal` (void), `_pollForResult` (status polling), `_callOmni` (ORM call to the server methods), result handling (`_handleResult` also keeps the slip fields), and defensive PAN masking. Registered in `registry.category('pos_payment_providers')` under the key `'aslan_omni'`. |
| `static/src/overrides/models/pos_payment.js` | A `patch()` on the core `PosPayment` model that adds `uiState.aslanOmniRef` / `uiState.aslanOmniResult` — the runtime-only (never persisted) slots the payment interface uses to remember the idempotency ref and the terminal's result for a given line — plus `aslanOmniMerchantPrinted` (merchant slip already printed) and `aslanOmniMerchantInline` (merchant slip is being added to the receipt document, browser printing). See §10 for why this lives in `uiState` rather than as a plain property. |
| `static/src/overrides/utils/generate_printer_data.js` | A `patch()` on `GeneratePrinterData.generatePaymentData` that copies `line.uiState.aslanOmniResult` (and the `aslan_omni_merchant_inline` flag) into the plain-data payment dict the receipt template renders from. Without this, the receipt template below would never see the card details, because `uiState` is runtime-only and not part of the normal payment-to-receipt-data pipeline. |
| `static/src/overrides/plugins/pos_ticket_printer_plugin.js` | A `patch()` on `PosTicketPrinterPlugin.printOrderReceipt`. With receipt printers it prints the merchant copy as a separate job right after the order receipt (`printAslanOmniMerchantSlips`, template `aslan_omni_payment.card_slip`) so the printer cuts between them. With browser printing it sets `aslanOmniMerchantInline` so the copy lands on its own page in the same document (separate jobs would replace each other in the shared iframe). Only lines with a result, not yet printed, on a method with the setting on. |
| `receipt/pos_order_receipt.xml` | A QWeb **inherit** of the core `point_of_sale.pos_order_receipt` template. Appends the card slip body signed "Copie client" after the receipt footer for any payment line that carries an `aslan_omni_result`, plus the merchant copy on its own page when `aslan_omni_merchant_inline` is set (browser printing). |
| `receipt/aslan_omni_card_slip.xml` | Defines `aslan_omni_payment.card_slip_body` (shared slip content, rows rendered only when present) and `aslan_omni_payment.card_slip` (standalone receipt document for the merchant copy, "Copie commerçant - A conserver"). |
| `static/src/backend/aslan_omni_pairing_widget/aslan_omni_pairing_widget.js` + `.xml` | Owl component + template mounted on the **backend** payment-method form (via the `aslan_omni_pairing` field widget declared in the views file above): enter the 8-char code, call `/cloud/pair` (from the manager's browser), store the returned key/device id on `pos.payment.method`, and re-pair / revoke. |

---

## 10. Where Odoo 20 bends this add-on's design (read if you're new to Odoo POS internals)

If you have maintained a payment-terminal add-on for an older Odoo (16/17/18),
several things here will look different on purpose. This section exists so you
don't "fix" them back to the old pattern.

- **Config lives on `pos.payment.method`, not `pos.config`.** In modern Odoo
  POS, a payment method (and its terminal credentials) can be shared across
  multiple tills, so all per-provider fields — including this add-on's three —
  live on `pos.payment.method`. Every core terminal provider (Stripe, Adyen,
  Viva Wallet) follows this same pattern; `pos_stripe` was used as the
  reference while building this add-on.
- **The payment interface takes a `line`, not an `order`.** `sendPaymentRequest`,
  `sendPaymentCancel`, and `sendReversal` all receive the `pos.payment` line
  directly. Everything about *this specific tender* — amount, order, UI state —
  hangs off that line, so there is no need to dig an order apart to find "the"
  payment being processed.
- **`PaymentInterface` lives at `@point_of_sale/app/utils/payment/payment_interface`,
  not `@point_of_sale/payment`.** The old import path was removed; using it
  throws at asset-bundle compile time (the till refuses to open) rather than
  failing quietly.
- **Registration is a registry, not an `extend` call.** New providers register
  with `registry.category('pos_payment_providers').add(key, Class)`. The `key`
  (`'aslan_omni'`) must exactly match the value registered in
  `_get_terminal_provider_selection()` in the model — a mismatch means the
  payment method exists and looks configured, but the terminal never gets
  called.
- **Runtime-only state goes through `uiState`, not a raw property.** A payment
  line in Odoo 20 is a reactive ORM-backed record; adding `line.aslanOmniRef = x`
  directly would try to treat it as a model field. The sanctioned pattern —
  used by `pos_stripe` and every other provider — is `patch()`-ing the
  `PosPayment` model's `setup()` to seed a `uiState` bag for your scratch data,
  which is exactly what `static/src/overrides/models/pos_payment.js` does.
- **The receipt is a server-rendered QWeb template, not an Owl component.**
  Odoo 20 generates `point_of_sale.pos_order_receipt` from Python/QWeb, fed by
  `GeneratePrinterData`. A provider that wants extra lines on the receipt
  inherits that template (`receipt/pos_order_receipt.xml`) **and** patches
  `generatePaymentData()` so the extra data actually reaches the template —
  both pieces are required; shipping only one silently does nothing. Templates
  the POS client renders itself (the card slip) must also be listed in
  `ir.ui.view._get_xml_ids_to_load()` (`models/ir_ui_view.py`).
- **The manifest version must NOT be hardcoded to a specific Odoo series.**
  Odoo's `check_version()` rejects a module whose version starts with a series
  prefix that doesn't match the *exact* running series (`20.0`, `20.1`, …) —
  and that series changes between Odoo pre-releases (we hit this first-hand:
  the module installed fine on `odoo:20` which reports itself as series
  `20.0`, but failed with `installable=False` on a `20.1a1` build). The fix,
  matching what core's own `point_of_sale/__manifest__.py` does, is a bare
  version with **no series prefix** (e.g. `'1.1.1'`): Odoo's `adapt_version()`
  then auto-prefixes it with whichever series is actually running, so the
  module stays installable across `20.0`, `20.1`, and future `20.x` builds
  without edits.
- **OWL's reactivity/ref primitives changed from `useState`/`useRef` to
  `proxy()`/`signal.ref()`.** This is easy to miss because `@odoo/owl` is
  imported the same way either way — the failure is a silent `undefined`
  import that only breaks at runtime when the component tries to use it, not
  at bundle-compile time. `static/src/backend/aslan_omni_pairing_widget/aslan_omni_pairing_widget.js`
  uses `proxy({...})` for reactive state and `signal.ref()` for DOM refs
  (bound as a class field, referenced in XML as `t-ref="this.codeInput"`,
  never a bare string key). The matching XML template also uses `t-out`
  instead of the removed `t-esc`, and every binding (`t-on-click`, `t-ref`,
  `t-out`) is `this.`-prefixed, mirroring core's own
  `pos_payment_provider_cards` component — use that file as the reference if
  you're adding another Owl component here.
- **A `static props`/`static defaultProps` class field is silently
  ignored.** OWL 3 only reads the props schema from an *instance* field set
  via `useProps(...)`, built from a typed schema (`t.string()`,
  `t.object()`, …). Declaring `static props = {...}` the old way doesn't
  error at bundle-compile time — it throws only when the component is
  actually instantiated, with
  `UncaughtPromiseError: Component "X" defines a static "props" ... which
  Owl 3 ignores`. `aslan_omni_pairing_widget.js` is a field widget (mounted
  via `<field widget="aslan_omni_pairing">`), so its props come from
  `standardFieldProps` (`@web/views/fields/standard_field_props`):
  `props = useProps(standardFieldProps)`. A view widget (mounted via
  `t-component`/`<widget>` outside a field) would use `standardWidgetProps`
  from `@web/views/widgets/standard_widget_props` instead — pick the one
  that matches how your component is mounted.
- **Three asset bundles, each scoped to what actually needs it:**
  - `point_of_sale._assets_pos` — everything needed to run a POS session (all
    of `app/**/*` and `overrides/**/*`).
  - `point_of_sale.payment_terminals` — a slim bundle containing just the
    payment interface + its `uiState` patch, loaded in contexts that need to
    know about terminal providers without booting a full POS session.
  - `web.assets_backend` — the pairing widget, because it is mounted on a
    **backend** form view (Settings), not inside a POS session. Shipping it
    under `_assets_pos` (as an earlier version of this add-on did) means it
    loads in the wrong place and never actually renders.

---

## 11. The server API this add-on calls

All endpoints live in `aslan-omni-api` (`src/routes/cloud.ts`), under the
`/cloud` prefix. Auth is a **merchant** bearer token (the API key from pairing)
unless noted. Except for pair and revoke, the caller is the **Odoo server**
(`_aslan_omni_request` in `models/pos_payment_method.py`, 15 s timeout, headers
`Authorization: Bearer <apiKey>` and `X-Device-Id`), never the browser.

| Method & path | Called by | Auth | Purpose |
|---------------|-----------|------|---------|
| `POST /cloud/pair` | pairing widget (manager's browser) | none (code is the secret) | Exchange the 8-char pairing code for `{ deviceId, apiKey }`. Rate-limited (10/min/IP). Code TTL 120 s. |
| `POST /cloud/pay` | Odoo server (`aslan_omni_send_payment`) | `Bearer <apiKey>` + `X-Device-Id` | Start a payment, sent with `wait: false`: answers `202 { commandId }` once relayed. Keyed on `ref` for idempotency. Returns the final result (`200`) if the ref already completed, `409 + commandId` if the ref is already running, `409 ref already used` if the ref belongs to another merchant or device, `503` if the terminal is offline. (Without `wait: false` it would long-poll up to 95 s and answer `408` on timeout; this add-on does not use that mode.) |
| `GET /cloud/pay/:commandId/status` | Odoo server (`aslan_omni_command_status`), polled by the POS every 3 s | `Bearer <apiKey>` + `X-Device-Id` | Status of a pay or reverse command: `{ status: pending\|completed\|timeout, resultStatus, ... }`. The command id is validated (`[A-Za-z0-9_-]{1,64}`) before it goes into the URL. |
| `POST /cloud/reverse` | Odoo server (`aslan_omni_send_reversal`) | `Bearer <apiKey>` + `X-Device-Id` | Void a prior approved payment using its `stan`. Same `wait: false` + idempotent-ref model as pay. |
| `POST /cloud/devices/:deviceId/revoke` | pairing widget (manager's browser) | `Bearer <apiKey>` | Revoke this device's pairing (clears its server-side key). The widget reads the key through the manager-only field to do this. |

**Why the polling window is 97 s:** the server keeps a command pending for
`COMMAND_TTL_MS = 95_000`. The POS polls for `97000` ms so the last poll still
sees the server's `timeout` status instead of giving up first.

---

## 12. Security model

- **HTTPS is mandatory.** Enforced by the model constraint on
  `aslan_omni_api_url` (a non-TLS URL cannot be saved) and re-checked by the
  pairing widget before it sends the pairing code.
- **The API key never reaches the POS browser.** `aslan_omni_api_key` carries
  `groups='point_of_sale.group_pos_manager,base.group_system'` and is **not** in
  `_load_pos_data_fields` (only `aslan_omni_device_id` and
  `aslan_omni_print_merchant_receipt` are). The POS calls the server methods
  `aslan_omni_send_payment`, `aslan_omni_send_reversal` and
  `aslan_omni_command_status`; `_aslan_omni_request` then:
  1. requires the caller to be in `point_of_sale.group_pos_user` (`AccessDenied`
     otherwise);
  2. runs `check_access('read')` on the payment method, so record rules
     (e.g. multi-company) apply **before** going `sudo()`;
  3. reads the key and device id with `sudo()` and calls the Omni API from the
     server (Bearer key + `X-Device-Id`, 15 s timeout, `wait: False`).

  The key is also rendered with `password="True"` on the backend form.
- **What a cashier can still do.** Anyone in the POS user group who can read a
  given payment method can ask the server to relay a payment or reversal through
  it, with whatever `ref` and amount they send — that is inherent to being a
  cashier. They cannot read the key or call the Omni API with it directly, and
  the server methods only talk to the Omni API URL configured (HTTPS-only) on
  that payment method.
- **The one place the key reaches a browser** is the manager's backend form:
  the pairing widget stores the key on pairing and reads it to call
  `/cloud/devices/:deviceId/revoke` on dissociation. Both need the manager
  groups on the field.
- **Card numbers are never stored in full.** The terminal/cloud already mask the
  PAN, and the client masks again defensively (`_maskPan` keeps only the last 4
  digits) before anything is stored in `line.uiState` or printed. No full PAN
  ever reaches Odoo's database or the receipt — consistent with SAQ-A scope.
- **No card data flows through Odoo.** The card is read on the terminal; Odoo
  only ever sees the *result* (approved/declined + masked metadata).

---

## 13. Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| *"Terminal Aslan Omni non configuré"* when charging | The payment method has no stored API key / device id | Pair the terminal (section 5). |
| *"Terminal non connecté"* (503) | The terminal has no live cloud connection | Check the terminal is powered on and online; retry. |
| *"Délai expiré"* (408, or a `timeout` status while polling) | Customer never presented a card within 95 s | Retry — nothing was charged. |
| *"Erreur serveur: ref already used"* (409) | The `ref` already belongs to another merchant or another terminal — e.g. the payment method was re-paired to a different terminal mid-payment | Start a new payment line (a new line gets a new ref) and charge again. |
| *"Erreur réseau…"* | The POS could not reach Odoo, or Odoo could not reach the Omni API, even after the recovery re-sends | Check connectivity, then re-click **Charge** on the same line — the stable ref prevents a double charge. |
| *"Aslan Omni API URL must use HTTPS"* | The configured URL is `http://` or malformed | Fix the **Aslan Omni API URL** to an `https://` endpoint. |
| Merchant slip does not print | **Print merchant card receipt** is off on the payment method, the POS session was opened before it was switched on, or this line's merchant copy already printed (once per payment line) | Tick the setting, close and reopen the POS session. |
| N° Commerçant / N° Terminal / N° Transaction missing from the slip | The Omni API or terminal app version does not send `acquirerMerchantId` / `acquirerTerminalId` / `transactionNumber` | Update the terminal app / API; the rows are simply omitted until then. |
| Pairing fails with *"Pairing code not found or expired"* | The 8-char code expired (120 s) or was mistyped | Generate a fresh code on the terminal and re-enter promptly. |
| *"Impossible d'annuler : STAN absent"* on reverse | The payment line has no stored STAN | Only approved Aslan Omni payments carry a STAN; you cannot reverse a line that was never approved through this flow. |
| Network dropped mid-payment, cashier unsure if it charged | Covered by the recovery loop (§8.2) | Re-click **Charge** on the *same* line — the stable ref prevents a double charge; the server returns the real result. |
| Asset bundle fails to compile / till won't open | A JS import path or registry key was changed and no longer matches core Odoo 20 | Re-check against [§10](#10-where-odoo-20-bends-this-add-ons-design-read-if-youre-new-to-odoo-pos-internals); confirm with `odoo -i point_of_sale,aslan_omni_payment --stop-after-init` that the module still installs cleanly. |

For deeper debugging, open the browser console: all failures surface through
`_showError`, and the network tab shows the `aslan_omni_*` RPC calls to Odoo. The `/cloud/*`
requests themselves are made by the Odoo server (see the Odoo log, logger
`odoo.addons.aslan_omni_payment.models.pos_payment_method`, for network
failures); only pairing and revoke are visible in the browser.

---

## 14. Known limitations

- **Any cashier can relay a payment through a method they can read.** The key
  is server-side only (see the [Security model](#12-security-model)), but the
  server methods do not check the amount or `ref` against an order — they
  relay what the POS sends.
- **No true remote cancel.** Cancelling in Odoo is a UI reset only; the terminal
  must be cancelled on the terminal. A real abort needs a new terminal-protocol
  message in `aslan-omni-api` (an SSE "AbortCommand" + a `/cloud/pay/:id/cancel`
  endpoint). Until that exists, rely on the stable-ref safety net (§8.3).
- **Odoo 20.0 only.** This add-on targets the 20.0 POS JavaScript architecture
  specifically (see §10). Installing it as-is on 16/17/18/19 will fail at
  asset-bundle compile time or at module install time. A downport would need to
  reverse most of §10's choices for the target version.
- **No automated tests.** The payment state machine (pay / recover / reverse) is
  exactly the kind of logic that benefits from QUnit/Hoot tests; none ship
  today. Until they do, test changes manually against a terminal or an emulator.

---

## 15. Glossary

| Term | Meaning |
|------|---------|
| **`ref`** | The idempotency key for one payment or reversal. Stable per payment line; the server dedups on it. |
| **`commandId`** | The server's internal id for a relayed command. Used to poll a command's status. |
| **STAN** | System Trace Audit Number — a per-transaction id from the card network, required to reverse a payment. |
| **RRN** | Retrieval Reference Number — another card-network transaction identifier printed on the receipt. |
| **SSE** | Server-Sent Events — the one-way live push the cloud uses to reach the terminal. |
| **Long-poll** | An HTTP request the server deliberately holds open (here up to 95 s) until it has an answer. The Omni API supports it for pay/reverse, but this add-on sends `wait: false` and polls instead. |
| **COF / NapsPay** | The terminal's card-acquiring stack; this add-on only sees its results, never its internals. |
| **`pos.payment.method`** | The Odoo model for one payment method (e.g. "Aslan Omni", "Cash"); this is where the Omni credentials live in Odoo 20, shared across any till that offers this method. |
| **`uiState`** | A runtime-only (never persisted, never synced) scratch object on a `pos.payment` line, used for data — like our pending ref and terminal result — that must not become a database field. |
| **Asset bundle** | A named group of JS/CSS/QWeb files Odoo compiles together for one context (a POS session, the backend UI, …). A broken import anywhere in a bundle fails the whole bundle's compile. |

---

*Part of the Aslan payment platform. Terminal-side firmware and the cloud relay
live in `aslan-omni` and `aslan-omni-api` respectively.*
