# Northwind Outfitters — Customer Support Policy Handbook

Version 4.2 · Effective 2026-01-01 · Owner: Support Operations

This handbook is the single source of truth for support agent decisions. When a
customer request conflicts with this document, this document wins. When this
document is silent, escalate rather than improvise.

---

## 1. Tone and Voice

1.1 Address the customer by first name if it is known. Never use a title plus
surname unless the customer used one first.

1.2 Lead with the resolution, not with the apology. "Your replacement ships
today" outranks "We're so sorry for the inconvenience."

1.3 One apology per message, maximum. Repeated apologies read as insincere and
measurably reduce CSAT in our post-contact surveys.

1.4 Never blame the customer, the carrier, or another department by name. Say
"the package was misrouted," not "FedEx lost it."

1.5 Never speculate about root cause. If engineering has not confirmed why
something broke, say we are investigating.

1.6 Do not use exclamation marks in messages about money, delays, or defects.

1.7 Plain language. No internal jargon: never write "RMA," "SKU," "P1," or
"tier-2" to a customer. Write "return," "item," "urgent," "specialist."

---

## 2. Refunds and Returns

2.1 **Standard return window is 60 days** from the delivery date, for any
reason, provided the item is in resellable condition.

2.2 **Defective items have no return window.** If an item fails due to a
manufacturing defect, we replace or refund it regardless of age. This is our
lifetime workmanship guarantee.

2.3 Refunds are issued to the original payment method. Processing takes 5–7
business days to appear on a customer's statement. Never promise "immediately."

2.4 **Store credit may be offered but never required.** If a customer asks for
a refund to their card, issue it to their card.

2.5 Return shipping is free for defective items, wrong items shipped, and any
order over $75. For all other returns, a $6.95 return label fee is deducted.

2.6 Items excluded from returns: personalized/engraved goods, opened food and
nutrition products, and clearance items marked "Final Sale."

2.7 **Agent refund authority is $200.** Refunds above $200 require a
supervisor. Do not split a refund into multiple sub-$200 transactions to avoid
approval — this is a terminable offense.

2.8 If an order was delivered more than 60 days ago and is not defective, the
correct answer is a polite decline plus a one-time 15% goodwill discount code.

---

## 3. Shipping and Delivery

3.1 Standard shipping is 5–7 business days. Expedited is 2 business days.
Overnight orders placed after 2:00 PM ET ship the following business day.

3.2 A package is not considered lost until **7 business days** past its
projected delivery date for domestic orders, or 21 calendar days international.

3.3 For a confirmed lost package, ship a replacement at no cost and do not ask
the customer to wait for the carrier investigation to close.

3.4 **"Delivered but not received"**: file a carrier trace, then ship a
replacement immediately if the order value is under $150. Above $150, a
supervisor reviews the account for prior claims first.

3.5 We do not ship to freight forwarders. Orders detected going to a known
forwarder address are cancelled and refunded in full before shipment.

3.6 Weather and natural-disaster delays are not eligible for shipping refunds,
but we will refund expedited shipping upgrades when the upgrade delivered no
benefit.

---

## 4. Billing and Subscriptions

4.1 The Trail Club membership is $89/year and auto-renews. We send a renewal
notice 14 days before the charge.

4.2 **Cancel any membership on request, no retention script, no exceptions.**
Ask once if they would like to hear about a cheaper tier; if they decline, cancel.

4.3 A membership charged within the last 30 days is fully refundable on
cancellation. Older than 30 days, it is prorated by remaining months.

4.4 Duplicate charges: refund the duplicate the same day. Do not ask the
customer to dispute it with their bank.

4.5 We never store full card numbers. If a customer sends card digits in a
message, do not repeat them back, and note that the message needs redaction.

---

## 5. Security, Privacy, and Escalation

5.1 **Never confirm or deny account details to an unverified requester.**
Verification requires the order number plus either the email on file or the
last four digits of the payment method.

5.2 Never send a password, reset link, or one-time code to any address other
than the verified email on file.

5.3 Escalate to a supervisor immediately, without attempting resolution, when:
  - The customer reports a physical injury or property damage from a product.
  - The customer mentions a lawyer, a lawsuit, or a regulator.
  - The customer alleges discrimination or harassment by staff.
  - A single account requests more than $500 in refunds within 30 days.
  - The customer mentions self-harm.

5.4 Product-safety reports (injury, fire, choking hazard, allergic reaction)
are logged to the Safety queue within one hour, no exceptions, even if the
customer says it is not a big deal.

5.5 Do not discuss another customer's order, ever, including with a spouse,
parent, or employer of the account holder.

5.6 Data deletion requests are routed to Privacy Operations. Agents must not
delete account records directly.

---

## 6. Discounts and Goodwill

6.1 Standing goodwill authority per agent: one 15% discount code per contact.

6.2 Stacking goodwill codes with an active promotion is not permitted.

6.3 Do not offer a discount as the first response to a defect. Fix the problem
first; offer goodwill only if the customer remains dissatisfied.

6.4 Price adjustments are honored within 14 days of purchase if the item drops
in price on our own site. We do not price-match other retailers.

---

## 7. What Never Goes in a Reply

- Internal ticket IDs, queue names, or agent shift schedules.
- Estimated engineering fix dates that have not been publicly announced.
- Any statement that a defect is "known" unless it is on the public status page.
- Promises about future product features.
- The words "unfortunately," "as per our policy," or "I'm afraid" — they are
  filler that signals a decline before the customer reads the substance.

---

## 8. Category Definitions (used by automated triage)

These definitions are normative. Automated triage and human agents must apply
the same boundaries so that routing metrics stay comparable across channels.

**billing** — Any dispute or question about money already charged or about to
be charged: duplicate charges, unexpected renewals, refund status, price
adjustments, tax questions, payment-method failures. If the customer's core
ask is "change what I was charged," it is billing, even if a defective product
prompted it.

**shipping** — Anything about the physical movement of goods: tracking that has
not updated, late delivery, wrong address, delivered-not-received, carrier
damage in transit, international customs holds. Damage discovered in an
unopened box is shipping; damage discovered after normal use is product_defect.

**product_defect** — The item is broken, malfunctioning, or materially not as
described: seams failing, zippers separating, waterproofing failing, sizing
grossly inconsistent with the published chart. Cosmetic preference ("I don't
like the color in person") is returns, not product_defect.

**returns** — The customer wants to send something back for reasons other than
a defect: wrong size, changed their mind, gift return, duplicate purchase.

**account** — Login problems, password resets, email changes, membership
enrollment or cancellation, address book edits, privacy and data requests.

**safety** — Any report of injury, illness, allergic reaction, fire, smoke,
choking, or property damage attributed to a product. Safety outranks every
other category: if a message could be read as a safety report, it is a safety
report.

**other** — Genuine pre-sales questions, partnership inquiries, press requests,
compliments, and anything that does not fit above. Do not use `other` as a
dumping ground for ambiguous tickets; pick the closest real category and lower
the confidence score instead.

### Urgency Definitions

**urgent** — Safety reports, anything in section 5.3, an order that must be
intercepted before it ships, or a customer who is currently stranded without a
product they need (e.g., gear for a trip departing within 48 hours).

**high** — Money is wrong right now (duplicate charge, failed refund), a
package is confirmed lost, or the customer has contacted us about this same
issue more than twice.

**normal** — The standard case: a question, a return request, a delivery that
is late but within the window in section 3.2.

**low** — Pre-sales curiosity, compliments, feature suggestions, and anything
with no deadline attached.
