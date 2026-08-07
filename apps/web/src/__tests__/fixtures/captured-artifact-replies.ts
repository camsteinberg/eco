// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Captured replies to the corpus's two "write me the message" asks, with a
 * reader's verdict on each — the ground truth for the `deliversAskedArtifact`
 * dim.
 *
 * WHAT THESE ARE. Real generations from the shipping default on-device model,
 * run against the everyday CONVERSATION corpus with the full history replayed,
 * in two arms of one experiment. Nothing here is written or edited: `text` is
 * the model's visible output, verbatim.
 *
 * WHY THEY ARE IN THE TREE. The eval harness only runs on demand against a
 * loaded model, so nothing in CI can produce a generation. Without captured
 * output, a scoring dim can only ever be tested against replies its own author
 * invented — which tests the author's imagination, not the instrument. These
 * thirty are what the model actually did, so the dim can be held to them.
 *
 * ★ TWO LAYERS, THE SAME SPLIT AS THE CORPUS FILES.
 *
 *   1. `text` — the record. Verbatim, never edited, and never edited to make a
 *      test pass.
 *   2. `handLabel` and `why` — a reader's verdict, made by reading every output
 *      in full BEFORE any scorer existed, against one stated property:
 *
 *        > the reply contains a sendable message or email in the person's own
 *        > voice, addressed to the audience their ask named, pasteable with at
 *        > most trivial edits. A labelled draft inside assistant framing
 *        > ("Here's the message: …") PASSES — the failure is notes, advice,
 *        > fragments or a deflection INSTEAD of the artifact, or an artifact
 *        > addressed to the wrong party.
 *
 *      1 delivers, 0 does not, 0.5 is artifact-shaped but heavily scaffolded
 *      announcement or flyer register. The verdicts are arguable and meant to be
 *      argued with — from the sample's own text, which is right here.
 *
 * ★ THE FACTS ARE A DIFFERENT DIM. Several delivered samples carry a wrong date,
 * an invented figure or a "[Restaurant Name]" placeholder, and they still score 1
 * here: whether the person's own facts survived is `preservesFacts`, and the
 * `why` lines say so where it applies. A dim that scored both would be unable to
 * tell "it wrote the wrong thing" from "it wrote the right thing wrongly".
 */

/** Which arm of the capture a sample came from. Recorded, not derived from. */
export type CapturedArtifactArm = 'before' | 'after';

/** One captured reply, with the reader's verdict on it. */
export type CapturedArtifactReply = {
  readonly id: string;
  /** The conversation-corpus item whose probed turn produced it. */
  readonly itemId: string;
  readonly arm: CapturedArtifactArm;
  /** 1 delivers, 0.5 borderline, 0 does not. */
  readonly handLabel: 0 | 0.5 | 1;
  /** Why, in the reader's words. Quote the sample; do not paraphrase it. */
  readonly why: string;
  /** The model's visible output, verbatim. */
  readonly text: string;
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 1 + 2 — thirty captured replies and the verdicts on them.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const CAPTURED_ARTIFACT_REPLIES: readonly CapturedArtifactReply[] = [
  {
    id: "birthday-before-1",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0,
    why: "Event scaffolding with £[X]/[Y]/[Z] placeholders and organiser sections. Nobody addressed, nothing signed.",
    text: "**📅 Birthday Party – March 8th**  \n**🍽️ Location:** [Restaurant Name]  \n**⏰ Time:** 1:00 PM  \n\n---\n\n### 📋 Details to Confirm\nPlease confirm attendance by **[insert return date]**.  \nIf you can’t come, let’s swap a friend or reschedule.  \nNo need to RSVP yet—just tell me if you’re coming!\n\n---\n\n### 💰 Costs\n- **Total cost:** £[X] (includes all meals)  \n- **Deposit paid:** £[Y]  \n- **Remaining balance:** £[Z]  \n\n*(Note: Please pay via bank transfer/phone to [Your Name] by [date].)*\n\n---\n\n### 👥 Attendance\n- **Denise:** Will attend  \n- **Kieran:** Will attend  \n- **Mum:** Will attend  \n- **Other guests:** Please list below or say “not coming”  \n*(Example: Jane Doe, John Smith, etc.)*\n\n---\n\n### 🎁 Gifts\n- Mum: No gifts (she’ll choose later)  \n- Others: Bring small items if you’d like (e.g., chocolates, wine, flowers)  \n*(Optional note: Some prefer no gifts this year.)*\n\n---\n\n### ✅ Next Steps\n- Confirm attendance by **[date]**  \n- Pay remaining balance by **[date]**  \n- Send any last-minute changes to this thread  \n\nLet’s keep things simple and clear! 😊\n\n--- \n\n*P.S. If anyone has allergies, please tell me early.*",
  },
  {
    id: "birthday-before-2",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 1,
    why: "A labelled \"Invitation Message Draft\" that is genuinely sendable, wrapped in a fact block and a meta tail — the artifact IS delivered.",
    text: "**📍 Where:** Bridgford Road (the Italian)  \n**⏰ Date/Time:** Wednesday 8th March, 1pm  \n**💰 Cost:** £25 per person + deposit (£50 total) already paid  \n\n**👥 Attendance:** 14 people  \n**🎯 Purpose:** Mum’s 60th birthday  \n\n---\n\n### 📝 Invitation Message Draft\n\nHi everyone,\n\nI’m organising Mum’s 60th birthday and would love to invite you to a simple meal out. We’re going to **Bridgford Road** on **Wednesday 8th March at 1pm**. It’ll be £25 per person plus a £50 deposit total (already paid).\n\nNo need for fancy drinks or expensive food — just a relaxed evening.\n\nPlease let me know if you can make it.\n\nThanks,  \n[Your Name]\n\n---\n\nLet me know if you’d like any adjustments! 😊",
  },
  {
    id: "birthday-before-3",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0,
    why: "Sections, \"Group Chat Notes\", \"Quick Tips\". No coherent message.",
    text: "**📍 Date/Time:** Sunday 8th March, 1pm  \n**👥 Guests:** 14 people  \n**💰 Cost:** £25 per person (cash/deposit already paid)  \n**🏡 Location:** [Insert Restaurant Name] – Back Room, away from the bar  \n\n---\n\n### 🎉 Welcome & What We’re Doing\nWe’re putting on a relaxed dinner for Mum’s 60th birthday. No fancy drinks, no games, just food and conversation. The vibe should feel like a casual weekend gathering.\n\n---\n\n### ✅ Key Details to Remember\n- **Time:** Sunday, 8th March, 1pm  \n- **Location:** [Restaurant Name], Back Room (away from the bar)  \n- **Cost:** £25 per person (deposit already paid via [payment method])  \n- **Dietary Needs:** Denise is Coeliac (please ensure GF pasta is served separately).  \n\n---\n\n### 🗣️ Group Chat Notes\n*Please keep this thread open.*  \n- If you’ve RSVP’ed by now, confirm attendance.  \n- If you haven’t yet, send a quick “I’m coming” – no pressure.  \n- If you need to clarify anything, just reply here.  \n\n---\n\n### 💬 Quick Tips for the Day\n- Arrive 30 mins early to settle in.  \n- Bring your phone charger and snacks.  \n- Keep the conversation flowing naturally.  \n\nLet’s make this special and comfortable! 🥂\n\n--- \n\n*Note: Please double-check the deposit payment method above before confirming.*",
  },
  {
    id: "birthday-before-4",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0,
    why: "A notes block. No message.",
    text: "**📅 Mum’s 60th Birthday – March 8th**\n  \n**🍽️ Location:** [Restaurant Name]\n   • Back room (away from the bar)\n   • Gluten-free pasta served in a separate pan\n   • Deposit paid (£50)\n\n**⏰ Time:** 1pm\n\n**👥 Guests:** 14 people total\n\n---\n\nI’m organizing this and would love to hear from everyone. Please share any updates if you’ve already confirmed attendance.\n\nLet me know if you need anything else! 🙌",
  },
  {
    id: "birthday-before-5",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0,
    why: "A flyer, plus heavy fabrication (\"Table #4\", \"Italian Friend – Already seated\").",
    text: "🎉 **The Birthday Lunch** 🎉  \n**Date:** Wednesday, 8th March  \n**Time:** 12:30 PM (1pm)  \n**Venue:** [Insert Restaurant Name]  \n\n---\n\n### ✅ What’s Included:\n- 14 seats total (£25 per person = £350 total)\n- Gluten-free pasta served in a *separate* cooking pan (confirmed by the restaurant!)\n- Table #4 – the last row on the left-hand side (away from the bar/noisy kitchen staff)\n- Deposit already paid (£50) — thanks Mum!\n\n---\n\n### 👥 Who’s Coming:\n- **Mum** – *no surprises needed!* (We’ll announce exactly what happens.)  \n- **Denise & Friends** – All confirmed, including her friend from Bridgford Road.  \n- **Kieran** – Shift worker, will arrive early.  \n- **Italian Friend** – Already seated.  \n- *(Add any others as they show up)*  \n\n---\n\n### 💡 Notes for Everyone:\n- **No gifts** required — we’re keeping the budget tight.  \n- **Quiet time** is key — please keep voices low.  \n- **Dietary restrictions**: Denise has Coeliac disease — please check all dishes again if unsure.  \n- **Pensioners**: Just focus on the food and conversation.  \n\n---\n\n### 📍 Where We Are:\n[Insert Address/Map Link]  \n*(Auntie Sue sits at the far end of the table — please bring water for her.)*  \n\n---\n\nLet’s make this a lovely, relaxed afternoon without stress. See you soon! 😊",
  },
  {
    id: "birthday-before-6",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0,
    why: "Notes with fabricated quoted updates, ending \"Let me know how I should proceed next!\" — to the person who asked.",
    text: "**📍 [Restaurant Name] – 8th March, 1pm**  \n**14 guests total (you + Mum)**  \n\n---\n\n### ✅ What’s confirmed:\n- **Date:** Saturday, 8th March  \n- **Time:** 1:00 PM  \n- **Table:** Back room (away from the bar)  \n- **Dietary:** Gluten-free pasta served in a separate pan  \n- **Deposit:** £50 already paid (to cover any issues)  \n\n---\n\n### 🗣️ Quick updates:\n- Mom: “I’ve checked the menu again” → She’ll see if she wants anything specific  \n- Denise: “We’re all seated, thanks”  \n- Auntie Sue: “Good afternoon”  \n- Others: “See ya”  \n\n---\n\n### 💰 Financials:\n- Deposit: £50 paid via [payment method]  \n- Total cost: ~£[X.XX] per person (based on average meal price)  \n- Payment due by end of week (no pressure)  \n\n---\n\n### 📅 Next steps:\n- Confirm arrival time for each guest  \n- Send a photo of the venue (if needed)  \n- Follow up on any last-minute changes  \n\n---\n\nLet me know how I should proceed next! 😊",
  },
  {
    id: "birthday-before-7",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 1,
    why: "A sendable message with a silly trailing meta note. Saturday is a fact failure, not a delivery one.",
    text: "**Subject:** Confirmation: Mum’s Birthday Lunch – 8th March\n\nHi everyone,\n\nJust confirming our booking:\n\n- **Date:** Saturday, 8th March  \n- **Time:** 1pm  \n- **Location:** [Restaurant Name]  \n\nPlease note:\n\n- We’re seated in the back room (away from the bar) as requested.  \n- The venue confirmed gluten-free pasta will be cooked in a separate pan.  \n- Deposit of £50 has been paid.\n\nThanks,  \n[Your Name]\n\n---\n\n*Note: This message avoids any clicky links or complex formatting. It’s clear, direct, and fits whatever devices your parents use.*",
  },
  {
    id: "birthday-before-8",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0.5,
    why: "An announcement signed \"— Organiser\": recipient-facing register, but notice-shaped, with [method] and [Insert Restaurant Name], and nobody addressed.",
    text: "**📅 MUM’S 60TH – BOOKED!**  \n*Date:* Saturday, 8th March  \n*Time:* 1pm (with lunch)  \n\n**🍽️ Venue:** [Insert Restaurant Name]  \n*Table:* Back room, away from the bar  \n\n**💰 Cost:** £25 per person total (£350 for 14 pax)  \n✅ Payment made via [method]  \n\n**⚠️ Important Notes:**  \n- Mum hates surprises → please share only what’s needed  \n- Denise (coeliac): confirmed GF pasta served in separate pan  \n- Auntie Sue: seated at far end of table (she’s deaf)  \n\nLet’s keep it simple and warm. Cheers! 🥂  \n\n— *Organiser*",
  },
  {
    id: "birthday-before-9",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 1,
    why: "Message-shaped and signed. \"Thanks for organizing this\" is a voice slip coming from the organiser.",
    text: "**📅 Family Meal Out – Wednesday 8th March**  \n\nHello everyone,  \nI’ve confirmed the booking for our family celebration! Here’s the quick summary:  \n\n- **Date:** Wednesday, 8th March  \n- **Time:** 1:00 PM  \n- **Location:** [Restaurant Name]  \n- **Cost:** £25 per person (deposit already paid)  \n- **Dietary Needs:** Gluten-free pasta served separately in a dedicated pan  \n- **Special Requests:** Auntie Sue will sit at the far end of the table (away from the noise); please let me know if any others need adjustments  \n\nThanks for organizing this—it’s going to be lovely. Let’s see you all soon! 🎉  \n\nWarm regards,  \n[Your Name]  \n\n---  \n*Note: I’ll keep the group chat updated as needed.*",
  },
  {
    id: "birthday-before-10",
    itemId: "convo-birthday-lunch-message",
    arm: "before",
    handLabel: 0,
    why: "Pure organiser notes with placeholder invitee lists.",
    text: "📅 **Mum’s 60th Birthday**  \n📍 **Sunday, 8th March | 1pm**  \n🍽️ **Dining Out (No Fancy Food)**  \n\n---\n\n### ✅ What We’re Doing\n- **Location:** [Restaurant Name] – Back Room (away from the bar)  \n- **Time:** 12:00 PM – 1:00 PM  \n- **Cost per person:** £25 (cash/take-home payment)  \n- **Total expected cost:** ~£350 (for 14 people)  \n\n---\n\n### 🗣️ Key Details to Share\n- Denise is Coeliac → confirmed GF pasta served in a *separate pan*  \n- Mum hates surprises → will be seated at the end of the table facing forward  \n- Auntie Sue is Deaf → seated far from the entrance/sound source  \n- Everyone has been told to bring their own drinks if needed  \n\n---\n\n### 💰 Payment Info\n- Deposit already paid (£50) via bank transfer to: [Your Bank Account / Phone Number]  \n- Final balance due: [Date] by [Time]  \n- All payments made before 11:59 AM  \n\n---\n\n### 👥 Who’s Coming\n*(List your invitees here)*  \n- [Name], [Relationship]  \n- [Name], [Relationship]  \n- ...etc...  \n\n---\n\nLet me know if you need anything else! 😊",
  },
  {
    id: "birthday-after-1",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 0,
    why: "Organiser notes: a \"Quick notes for the group chat\" section and an optional aside to the person who asked.",
    text: "📍 **Bridgford Road Italian**  \n⏰ **Sunday 8th March @ 1pm**  \n💵 **£25 per person (cash)**  \n\n---\n\n### ✅ What’s confirmed:\n- **Time**: 1pm start (Kieran’s shift ends by 7, so we’ll leave early).\n- **Table**: Back row, far from the bar (quiet enough).\n- **Dietary**: Gluten-free pasta served in a separate pan (asked beforehand).\n- **Deposit**: Paid (£50 covered upfront).\n\n---\n\n### 📝 Quick notes for the group chat:\n- Bring wallets if needed (deposit already paid).\n- No need to worry about “surprises” – everyone knows exactly what’s happening.\n- Denise’s GF status confirmed via separate pan (no issues expected).\n- Auntie Sue seated last, facing away from the noise source.\n\n---\n\nLet’s go! 🎉\n\n*(Optional: Add a small note to Kieran: “We’ll grab the car after 1pm, so let him know he’s good till 7.”)*",
  },
  {
    id: "birthday-after-2",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 0,
    why: "Briefing register — \"Talking Points\", \"Important Notes\" — with invented constraints (bring your own food, no alcohol). No coherent message.",
    text: "**📍 Italian Restaurant (Bridgford Road)**  \n**📅 Date:** Sunday, 8th March  \n**⏰ Time:** 1:00 PM  \n**💰 Cost:** £25 per person  \n\n---\n\n### ✅ What’s confirmed:\n- **Date & Time:** Confirmed for Sunday, 8th March, 1:00 PM  \n- **Cost:** Each person pays £25 (cash or transfer)  \n- **Location:** Bridgford Road – side tables only, away from the main bar area  \n- **Dietary:** Gluten-free pasta served in a separate pan (confirmed by the restaurant)  \n- **Deposit:** Already paid (£50 total)  \n\n---\n\n### 🗣️ Talking Points:\n- “We’re going to [Restaurant Name] on Sunday, 8th March, at 1:00 PM.”  \n- “Everyone brings their own food and drinks.”  \n- “No alcohol unless explicitly mentioned.”  \n- “Mum will take notes on any changes.”  \n\n---\n\n### ⚠️ Important Notes:\n- **Kieran’s availability:** He’ll be able to come if he’s fit today.  \n- **Denise’s diet:** We’ve confirmed GF options are handled correctly.  \n- **Auntie Sue’s seating:** She’ll sit at the end of the table facing out, away from the noise.  \n- **Mum’s comfort:** She’ll review the menu beforehand and check if anything needs adjustment.  \n\n---\n\nLet’s keep it simple and focused! Let’s go! 😊",
  },
  {
    id: "birthday-after-3",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 0.5,
    why: "An invitation flyer signed \"[Your Name]\": recipient-facing, but heavy section scaffolding, organiser payment mechanics and an @username. Nobody addressed.",
    text: "**📅 Family Group – March 8th Lunch Invitation**  \n\n*Date:* Wednesday, 8th March  \n*Time:* 1:00 PM  \n*Location:* Italian on Bridgford Road (back room, quiet)  \n*Cost:* £25 per person (deposit already paid)  \n\n---\n\n### 🎉 What’s Happening Today  \nMum’s 60th Birthday!  \nWe’re doing a relaxed meal out at the Italian place. No pressure, no formalities. Just food, conversation, and celebrating together.  \n\n---\n\n### 👥 Who’s Coming  \n*(Please confirm if you can make it)*  \n\n---\n\n### 🛑 Important Notes  \n- **Kieran:** Will be arriving early (before 7am) as he has shifts. We’ll handle seating logistics.  \n- **Denise:** Coeliac – please let everyone know how to order safely.  \n- **Auntie Sue:** Deaf – will be seated near the back/away from noise. Please ensure she’s included in seating arrangements.  \n- **Mum:** Does NOT like surprises. She knows exactly what’s happening.  \n\n---\n\n### 💰 Payment Details  \n- Deposit: £50 (paid via bank transfer)  \n- Balance due: £25 × 14 = £350  \n- All payments go directly to the organizer.  \n\n---\n\n### ✅ Next Steps  \n1. Confirm attendance by [insert deadline].  \n2. Send any dietary restrictions (especially Denise’s).  \n3. Bring change for tips.  \n\nLet’s make this special.  \n\nWith love,  \n[Your Name]  \n\n--- \n\n*P.S. If anyone needs help arranging seating or ordering, just ping @username.*",
  },
  {
    id: "birthday-after-4",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 1,
    why: "Email-shaped and sendable.",
    text: "**Subject: Booking confirmation – Mum’s 60th Birthday**\n\nHi everyone,\n\nJust confirming our bookings for **Sunday, 8th March** at **Italian on Bridgford Road**.\n\nWe’ve got:\n- **Time:** 1:00 PM  \n- **Location:** Back room (away from the bar)  \n- **Cost:** £25 per person  \n\nPlease let me know if you need anything else from here.\n\nThanks,  \n[Your Name]  \n\n---\n\n*Note: The deposit (£50) has already been paid via the booking system.*",
  },
  {
    id: "birthday-after-5",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 1,
    why: "A clean short message.",
    text: "Hi everyone,\n\nJust confirming our plans: **Sunday 8th March, 1pm**, at **Italian on Bridgford Road**.\n\nWe’re seating 14 people (£25 per head), and Mum has already paid the deposit.\n\nPlease let me know if anyone needs to adjust anything.\n\nThanks,  \n[Your Name]",
  },
  {
    id: "birthday-after-6",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 1,
    why: "A message. The one \"[insert deadline]\" bracket is a fact residual, which preservesFacts owns.",
    text: "Hey everyone,\n\nJust confirming our plans for Mum’s 60th on **Sunday, 8th March** at **Italian on Bridgford Road**.\n\nHere’s the quick summary:\n- **Time:** 1pm\n- **Cost:** £25 per person (deposit already paid)\n- **Location:** Back room away from the bar\n- **Dietary note:** Gluten-free pasta served in a separate pan (confirmed by the venue)\n\nPlease RSVP by [insert deadline] if you’re coming.\n\nThanks,  \n[Your Name]",
  },
  {
    id: "birthday-after-7",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 1,
    why: "A message. \"Wednesday 8th\" twice is a FACT failure; delivery is fine.",
    text: "**Subject:** Confirmation – Mum's 60th Birthday Lunch (Wednesday 8th)\n\nHi everyone,\n\nJust confirming our plan for Wednesday 8th: **1pm at Italian on Bridgford Road**.\n\nDetails:\n- **Time**: 1pm (everyone has their own car/sat down)\n- **Venue**: Italian on Bridgford Road\n- **Cost**: £25 per person\n- **Dietary**: Gluten-free pasta served in a separate pan (confirmed by the restaurant)\n- **Seating**: We're in the back room, away from the bar\n\nPlease let me know if anyone needs to come along or if there are any last-minute changes.\n\nThanks,  \n[Your Name]",
  },
  {
    id: "birthday-after-8",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 0,
    why: "Organiser notes: \"Your 14 guests\" addresses the person who asked, the next steps are the organiser’s, and £22.40/head is invented arithmetic.",
    text: "**📅 MUM'S 60TH BIRTHDAY – SUNDAY 8TH MARCH @ ITALIAN ON BRIDGORD ROAD**\n\n- **Time:** 1:00 PM  \n- **Cost per person:** £25 (deposit already paid)  \n- **Location:** Italian Restaurant (back room away from bar)  \n- **Dietary note:** Gluten-free pasta served in a separate pan  \n\n---\n\n### 🎉 What’s coming up:\nThis will be a relaxed, comfortable meal without any surprises. Mum knows exactly what’s happening and will be happy with the plan. We’ll keep it simple and low-key.\n\n### 👥 Who’s attending:\n- Your 14 guests total  \n- Includes Denise (coeliac, proper allergy info confirmed)  \n- Kieran (shift worker, arrives early)  \n- Everyone else  \n\n### 💰 Payment details:\n- Deposit: £50 (paid via [method])  \n- Remaining balance: £22.40 per head (£25 × 14 = £350 total)  \n- All payments made before the event  \n\n### ✅ Next steps:\n1. Confirm attendance with everyone  \n2. Send a reminder with the full list and payment status  \n3. Final check on any last-minute changes  \n\nLet’s make sure everything runs smoothly!",
  },
  {
    id: "birthday-after-9",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 0,
    why: "Addressed to the USER about the booking — \"Next steps: Send the confirmation to Mum\" — with a £5-per-person deposit derivation.",
    text: "**Good news!** The Italian on Bridgford Road has confirmed their spot for **Sunday 8th March at 1pm**. They’re putting us all in the back room away from the bar. Deposit was £50 (£5 per person).\n\n**Next steps:**  \n- Send the confirmation to Mum (she’ll thank you)  \n- Confirm with Denise if she knows anything extra about the menu or seating  \n- Check the final bill to confirm no hidden costs  \n\nLet’s keep it simple and avoid any surprise fees. 🌿",
  },
  {
    id: "birthday-after-10",
    itemId: "convo-birthday-lunch-message",
    arm: "after",
    handLabel: 1,
    why: "Email-shaped and sendable. \"[Restaurant Name]\" is the fact residual.",
    text: "**Subject:** Confirmation – Mum’s 60th Birthday Dinner (March)\n\nHi all,\n\nJust confirming the booking details:\n\n- **Date:** Sunday, 8th March  \n- **Time:** 1pm  \n- **Venue:** [Restaurant Name] – Back Room only  \n- **Cost:** £25 per person  \n- **Deposit:** Paid  \n\nPlease RSVP by tomorrow. Thanks!\n\nBest,  \n[Your Name]",
  },
  {
    id: "teacher-before-1",
    itemId: "convo-teacher-email-resend",
    arm: "before",
    handLabel: 0,
    why: "Deflects and asks for a calendar.",
    text: "Sure — I’ll rephrase it to include the specific dates. Do you mean the next two weeks? Or did you have a typo in your schedule? Just send me the correct calendar and I’ll adjust the wording accordingly.",
  },
  {
    id: "teacher-before-2",
    itemId: "convo-teacher-email-resend",
    arm: "before",
    handLabel: 0,
    why: "\"Just hit send now.\" Nothing is delivered.",
    text: "I'll send it again with the specific dates included. Just hit send now.",
  },
  {
    id: "teacher-before-3",
    itemId: "convo-teacher-email-resend",
    arm: "before",
    handLabel: 0,
    why: "Asks questions whose answers are already in the conversation.",
    text: "Sure — I'm happy to resend. Please tell me:\n\n- The date range (e.g., \"Thursday through Friday\")\n- Your preferred day names (e.g., \"Mon through Fri\")\n- Whether you want to include time slots, timesheets, or any other specifics\n\nOnce I have those, I'll draft the email again with the correct days.",
  },
  {
    id: "teacher-before-4",
    itemId: "convo-teacher-email-resend",
    arm: "before",
    handLabel: 0,
    why: "A nonsense deflection.",
    text: "I’m sorry I didn’t paste the full list earlier. Please send again—I’ll include every day clearly.",
  },
  {
    id: "teacher-before-5",
    itemId: "convo-teacher-email-resend",
    arm: "before",
    handLabel: 1,
    why: "The full email draft, inside assistant framing.",
    text: "No problem — I’ll send the updated version below:\n\n“Hi [Name] — copying the front office per the attendance policy. [Son] will be out Thursday and Friday for a family trip. Could you let me know if there’s anything he should take with him or make up when he’s back? Thanks so much.”\n\nThat’s clear and meets the requirement.",
  },
  {
    id: "teacher-after-1",
    itemId: "convo-teacher-email-resend",
    arm: "after",
    handLabel: 0,
    why: "A false \"I don’t have access to your past messages\" refusal.",
    text: "I’m sorry—I don’t have access to your past messages. Please tell me the specific dates you need included in the email.",
  },
  {
    id: "teacher-after-2",
    itemId: "convo-teacher-email-resend",
    arm: "after",
    handLabel: 0,
    why: "Fragments plus advice — \"Just use: ‘Thursday and Friday’\".",
    text: "Here’s the corrected version to send:\n\n- “I’ll be out Thursday and Friday.”  \n- That covers the required absence period.\n\nNo need to repeat the full days unless your calendar shows something else. Just use:\n\n“Thursday and Friday”\n\nThat’s clear and meets the requirement without extra fluff.",
  },
  {
    id: "teacher-after-3",
    itemId: "convo-teacher-email-resend",
    arm: "after",
    handLabel: 0,
    why: "Bullet fragments, not an email.",
    text: "Got it. Here’s the plain version:\n\n- Thursday is out.  \n- Friday is out.  \n\nThat’s two full days. No “a couple” needed. Just list the dates clearly.",
  },
  {
    id: "teacher-after-4",
    itemId: "convo-teacher-email-resend",
    arm: "after",
    handLabel: 0,
    why: "Imperative advice to the person who asked.",
    text: "Send again with the full dates spelled out: \"Thursday and Friday\". That way the school sees them clearly.",
  },
  {
    id: "teacher-after-5",
    itemId: "convo-teacher-email-resend",
    arm: "after",
    handLabel: 1,
    why: "The full email, introduced with \"Sent again: …\".",
    text: "Sent again: \"Hi [Teacher] — copying the front office per the attendance policy. Son will be out Thursday and Friday for a family trip. Could you let me know if there's anything he should take with him or make up when he's back? Thanks so much.\"\n\nThis version explicitly names the dates, making it clear and avoiding any ambiguity about when the absence applies. It keeps the tone professional while ensuring your request lands correctly.",
  },
];

/** Samples for one corpus item, in capture order. */
export function capturedRepliesFor(itemId: string): readonly CapturedArtifactReply[] {
  return CAPTURED_ARTIFACT_REPLIES.filter((reply) => reply.itemId === itemId);
}
