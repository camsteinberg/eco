// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Frozen captures for the over-writing instrument (M2 mechanism 1) — 35 verbatim
 * replies from the shipping model (candidate/qwen3.5-2b-onnx, production
 * composition, sampled decode), taken from the two independent M2 baseline
 * batches of 2026-08-06. Selection was flag-guided (bracket slots, time-words,
 * markdown apparatus) but every label below was assigned by a READER against
 * the corpus item's ask, goodAnswerLooksLike and bounceCondition — BEFORE any
 * scorer for these dimensions existed. Mirrors captured-artifact-replies.ts.
 *
 * The three hand labels (0 defect / 0.5 partial / 1 clean) are deliberately
 * orthogonal to each other and to correctness:
 *
 * - unfilledSlots: a bracket-slot is a defect when (a) the slotted fact was
 *   GIVEN by the user (Sarah / Dez / Devi), (b) it is inserted into the user's
 *   own reproduced text ("[answer]"), (c) slots are so numerous the artifact
 *   is a template, or (d) the slot invites the user to author content
 *   ("[specific skill, e.g., ...]"). Name/date/phone blanks for genuinely
 *   unknown facts are NOT defects (the gym item's GOOD asks for them).
 * - inventedTime: the reply commits to a time/day the ask never gave
 *   ("next week", "tomorrow morning", "last week"). A time-word SOURCED from
 *   the ask is clean — summarise-01's "tonight" is in the thread, so any
 *   detector must be differential against the ask, never a bare word list.
 * - artifactBurial: the asked-for artifact/answer is delivered as the reply
 *   (a one-line preamble is fine) versus buried under or replaced by
 *   apparatus — Option/Version multiplicity for a single ask, "Changes Made &
 *   Rationale"/"Trade-offs" sections, bold-field outlines, per-marker
 *   enumerations the ask didn't want. Fidelity/corruption failures belong to
 *   preservesUserText/preservesFacts, not here.
 *
 * Frozen captures cannot notice the model getting better — only the
 * instrument being loosened. Findings recorded while labeling (NOT measured
 * by these dims, kept for the record): summarise-01 corrupted "surprise bit
 * is 7 not 8" (a TIME) into "£7, not £8" (money) in all three labeled
 * samples; proofread-school-post b1/s1 signed the user's own post
 * "Best, Eco".
 */

export type OverwriteHandLabels = {
  /** 0 defect / 0.5 partial / 1 clean — see file header for the rubric. */
  unfilledSlots: 0 | 0.5 | 1;
  inventedTime: 0 | 0.5 | 1;
  artifactBurial: 0 | 0.5 | 1;
};

export type CapturedOverwriteReply = {
  /** "<batch>/<corpus item id>/s<sampleIndex>" — batch runIds in the header. */
  id: string;
  itemId: string;
  runId: string;
  sampleIndex: number;
  handLabels: OverwriteHandLabels;
  why: string;
  output: string;
};

export const CAPTURED_OVERWRITE_REPLIES: readonly CapturedOverwriteReply[] = [
  {
    id: "b1/draft-01/s1",
    itemId: "draft-01",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 1 },
    why: "3 name slots, all for genuinely unknown facts; short direct email",
    output: "Subject: Quick check regarding [Child's Name]'s reading progress  \n\nHi [Teacher's First Name],  \n\nI hope you're having a great week! I wanted to reach out because I noticed [Child's Name] seems to be falling slightly behind in their reading practice recently. While we've been working together, I'm wondering if there might be any adjustments we could make at home to support them better?  \n\nIf you have any ideas or suggestions, I'd really appreciate your thoughts—I'm happy to adjust our routine accordingly. Thanks so much for everything!  \n\nWarmly,  \n[Your Name]",
  },
  {
    id: "b1/draft-01/s2",
    itemId: "draft-01",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 0, inventedTime: 0, artifactBurial: 1 },
    why: "[specific skill, e.g., ...] INSERT-DETAIL slot forces parent to fill pedagogy; 'next week' + 'been a few days since we started' invented",
    output: "Subject: Quick check on [Child's Name]'s reading progress  \nHi [Teacher's Last Name],  \n\nI hope you're having a great week! I wanted to reach out because I noticed [Child's Name] seems to be slightly slower catching up on recent lessons.  \n\nIt’s been a few days since we started focusing on [specific skill, e.g., decoding words / recognizing letters], and I’m seeing some gaps compared to peers. My goal is simply to support their learning—not to find fault.  \n\nCould you let me know if there’s any extra time we could have next week? Or perhaps a quick office visit where we can go over some of the material together?  \n\nThanks so much for your guidance—I really appreciate your work helping our students!  \n\nBest regards,  \n[Your Name]  \n[Your Phone Number]",
  },
  {
    id: "b1/admin-gym-cancellation/s1",
    itemId: "admin-gym-cancellation",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 1 },
    why: "GOOD explicitly allows marked blanks; 3 acceptable slots (name/phone/date). Fact inversion ('failed to renew') is preservesFacts territory, not these dims",
    output: "**Subject: Request for Refund – [Your Full Name]**\n\nDear Gym Membership Team,\n\nI am writing to formally request a full refund for my gym membership. I originally signed up in March but failed to renew by the deadline. Since then, I have made three additional payments under the assumption that I had renewed, which is incorrect.\n\nAs of today, I no longer use the facility. The fact that I paid three times for something I did not use confirms a billing error on their part. This is a non-recurring charge, so I expect the remaining balance to be refunded immediately upon cancellation.\n\nPlease find attached proof of my initial signup date (the March cancellation) and copies of my three recent payments as evidence of the overpayment.\n\nThank you for your prompt attention to this matter. I look forward to hearing from you.\n\nSincerely,  \n[Your Full Name]  \n[Phone Number]  \n[Date]",
  },
  {
    id: "b1/admin-gym-cancellation/s2",
    itemId: "admin-gym-cancellation",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 0, inventedTime: 1, artifactBurial: 1 },
    why: "7 slots incl. [Date Returned] for an invented card-return event and [number, e.g., 5 business days] asking user to pick own deadline — the bounce's 'more work than writing it themselves'",
    output: "**Subject: Request for Full Refund – Gym Membership (Cancelled March)**\n\nDear [Gym Name] Customer Support Team,\n\nI am writing to formally request a full refund for my gym membership. I canceled my account on **March [Day of Month]** but received three additional payment charges shortly after. My gym card was returned on **[Date Returned]**.\n\nAccording to our agreement and standard cancellation policies, no further fees should be applied once the original contract is terminated. The fact that I paid again suggests either a processing error or an issue with the cancellation confirmation. Since I did not use any services during the period I was absent from the gym, I believe these charges were unnecessary.\n\nCould you please provide:\n1. Proof that my account has been fully closed.\n2. An explanation for why I owe further payments despite cancelling.\n3. A method to process a refund for the total amount charged.\n\nI would appreciate a response within **[number, e.g., 5 business days]**. Please contact me directly at **[Your Phone Number/Email]** so I can discuss this matter.\n\nSincerely,  \n[Your Name]  \n[Your Phone Number]",
  },
  {
    id: "b1/work-sick-text/s1",
    itemId: "work-sick-text",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 0.5, inventedTime: 1, artifactBurial: 1 },
    why: "[Boss's Name] slot in a text message where no name is needed — user must edit before sending",
    output: "Hey [Boss's Name], I'm so sorry about the food poisoning! I'll take a quick look at my schedule and let you know if I can work from home today, or if I need to call you back. Hope you're feeling better soon.",
  },
  {
    id: "b1/work-sick-text/s2",
    itemId: "work-sick-text",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 0.5, inventedTime: 1, artifactBurial: 1 },
    why: "same [Boss's Name] slot",
    output: "Hey [Boss's Name], I'm so sorry I can't make it in today—I've got a stomach bug. I'll try to catch up on whatever is urgent, but I'll let you know if there's anything specific I need to focus on while I'm out of the office. Thanks for understanding!",
  },
  {
    id: "b1/proofread-vet-application/s1",
    itemId: "proofread-vet-application",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 0, inventedTime: 0, artifactBurial: 0 },
    why: "[Your Full Name] slot though name Devi given in paste; 'covered shifts last week' invents time AND inverts her fact; artifact replaced by reply-to-Devi + ATS cover letter + Why-these-changes essay",
    output: "Hello Devi, thanks for reaching out. It's great to meet someone who values honesty and resilience. Your experience with restraint and animal welfare sounds incredibly impressive—those days sitting while others put down animals is particularly touching. You also mentioned the flexibility you showed when covering shifts due to family emergencies; that kind of reliability is rare and very valuable.\n\nHere’s how I’d refine your message for clarity, professionalism, and impact without sounding overly confident:\n\n---\n\n**Subject:** Application for Vet Assistant Position – [Your Full Name]\n\nDear Hiring Team,\n\nMy name is **Devi**, and I’m writing to apply for the Vet Assistant role. While I don’t currently hold any formal veterinary certification, I’m fully transparent about it upfront—I’m eager to learn and grow in this field.\n\nOver the past three years, I’ve volunteered at a local animal shelter on Marsh Road. My responsibilities included:\n- Restraint training for timid or anxious dogs (including those needing special handling)\n- Daily cleaning of kennel areas—a task none other than volunteers typically avoided\n- Providing emotional support during euthanasia ceremonies, helping keep calm as animals were placed in carriers\n\nOutside of work, I maintain strong communication skills, adapt quickly to new situations, and treat every interaction with care. For example, I covered shifts last week when my mother had surgery, working through the night to ensure no delay caused to the team.\n\nI understand that my resume may lack traditional qualifications, but I believe my dedication, reliability, and willingness to learn more than compensate. If given the opportunity, I would be happy to complete training quickly and contribute meaningfully from day one.\n\nThank you for considering my application. I’d love to discuss how I can support your team.\n\nWarm regards,  \n**Devi**\n\n---\n\n### Why these changes matter:\n- **Clear structure**: Bullet points let hiring managers scan key responsibilities quickly.\n- **Honest tone**: “I don’t currently hold... but I’m fully transparent” builds trust without over-explaining.\n- **Specific examples**: Mentioning “euthanasia support” and “morning coverage” grounds your claims in reality.\n- **No hype**: Avoids phrases like “I’m confident” or “I’m better than others.” Instead, focuses on actions and attitude.\n- **Call to action ends naturally**: Doesn’t push for an interview immediately—it invites discussion first.\n\nWant me to tailor this further? We can adjust the focus toward certifications",
  },
  {
    id: "b1/proofread-vet-application/s2",
    itemId: "proofread-vet-application",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 0, inventedTime: 1, artifactBurial: 0 },
    why: "[Last Name]/[Phone]/[LinkedIn] slots for an application BOX; full restructure into sections + rationale essay",
    output: "Here is a revised version of your cover letter. I've tightened the grammar, smoothed out the phrasing to sound more professional yet authentic, and kept your honest tone intact. I also organized it into clear sections as requested.\n\n### Revised Cover Letter\n\n**Subject:** Application for Veterinary Assistant Position – Devi [Last Name]\n\nDear Hiring Team,\n\nMy name is Devi. I am writing to express my interest in the Veterinary Assistant position. While I currently lack the specific certification mentioned on the job posting, I am fully prepared to obtain it quickly and would welcome the opportunity to demonstrate my skills in a real-world setting.\n\n**My Background**\nFor three years, I volunteered at a local animal shelter located on Marsh Road. During this time, I gained hands-on experience with a wide variety of tasks essential for a veterinary assistant. My daily responsibilities included restraining calm and anxious dogs, cleaning kennels (including those rarely used), and providing comfort during difficult medical procedures where other staff chose not to intervene. These experiences taught me patience, empathy, and the importance of animal welfare above all else.\n\n**Availability and Reliability**\nAlthough I haven't called out recently, my reliability has been solid. The only instance I called out was when my mother was hospitalized, which I took up from there. I am committed to being available whenever needed and eager to commit to a flexible shift schedule.\n\n**My Approach**\nWhile I acknowledge that my resume may appear to have fewer credentials than ideal candidates, I believe my practical experience makes me a strong fit. I don't view this as a limitation but rather as an opportunity for growth. I am quick to learn new protocols and tools, and I am eager to apply what I learned while volunteering to solve problems and contribute effectively to your team.\n\nThank you for your time and consideration. I look forward to the possibility of discussing how I can support the clinic's goals.\n\nSincerely,\n\nDevi [Last Name]\n[Phone Number]\n[Link to LinkedIn/GitHub if available]\n\n***\n\n### Why these changes were made:\n\n*   **Credibility First:** Instead of hiding the lack of certification immediately, I placed the sentence right after introducing myself. This frames the gap as something you are actively solving (\"fully prepared...\"). It's much stronger than saying \"I don't have the cert\" at the top.\n*   **Conversational Voice:** Phrases like \"scared dogs,\" \"wernt by themself,\" and \"made that shift",
  },
  {
    id: "b1/sw-15/s1",
    itemId: "sw-15",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 0, inventedTime: 1, artifactBurial: 0 },
    why: "literal [answer] slot inserted INTO the user's own corrected text; artifact wrapped in Changes Made & Rationale + Tradeoffs apparatus with wrong grammar claims",
    output: "Here is the corrected version of your message, followed by a breakdown of why I made those changes so you can keep your original tone while ensuring clarity and professionalism.\n\n### Corrected Version\n\n> \"So basically, what happened was we got to the site at 7, and the crew wasn't there. I called Mike twice without a [answer]. By 8:30, I decided to start on the demo myself because we were already behind. Around 10, Mike shows up and says his truck wouldn't start. I told him that's fine, but he needs to call next time. We ended up finishing the demo by 3, which honestly isn't bad considering the timeline. Materials are being delivered Thursday.\"\n\n---\n\n### Changes Made & Rationale\n\nSince you requested **not** to change your voice, here is how I fixed the errors while preserving the casual, spoken-word feel of your original text:\n\n*   **\"no answer\" → \"without an answer\"**\n    *   *Reason:* This is grammatically correct (\"no answer\" can sound incomplete). Adding \"an\" makes it flow better.\n*   **\"we was\" → \"we were\"**\n    *   *Reason:* \"We were\" matches the past tense verb \"were\" (matching \"had\"). \"Was\" is incorrect for plural subjects like \"we.\"\n*   **\"considering\" → \"considerable\"**\n    *   *Reason:* \"Considering\" usually requires a noun (e.g., \"considering the weather\"). However, \"bad considering\" is non-idiomatic. Changing it to \"**considerable**\" fits naturally in casual conversation. Alternatively, if you meant \"it wasn't bad *because* of the situation,\" you could use \"considerable.\"\n*   **\"Materials are getting delivered\" → \"Materials are being delivered\"**\n    *   *Reason:* \"Getting delivered\" sounds slightly clunky. \"Being delivered\" is more standard professional/neutral phrasing. If you specifically mean the trucks are physically arriving right now, \"are delivering\" works too.\n\n### Tradeoffs & Recommendations\n\nBased on the context, here are some suggestions to improve the effectiveness of your communication:\n\n#### 1. The \"No Answer\" Issue\n*   **Current:** \"...called Mike twice without an answer.\"\n*   **Tradeoff:** Being blunt about silence can lead to frustration.\n*   **Recommendation:** You might say, *\"I called Mike twice, but",
  },
  {
    id: "b2/proofread-crew-email/s2",
    itemId: "proofread-crew-email",
    runId: "eval-mshirxl2-c592rkht",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 0, inventedTime: 1, artifactBurial: 0 },
    why: "[Your Name] though signed Dez; complete HR-memo rewrite with trade-off bullets — the exact bounce",
    output: "**Subject:** Important update regarding the scanner rollout & badge system\n\nHi everyone,\n\nI'm writing to give you the go-ahead to switch back to the **new scanners on Monday**. Please don't hesitate to use them.\n\nHere are a few key points and trade-offs to keep in mind as we transition:\n\n*   **Badge Requirement**: Every shift requires a badge now. It's possible to forget, but we're adjusting for speed.\n    *   *Trade-off:* Forcing a badge immediately slows down the initial setup (1–2 minutes per person). However, long-term efficiency will improve significantly once adapted.\n    *   *Action:* If you're busy during your first few shifts, wear a tag temporarily to avoid delays. Once adjusted, badges become seamless.\n\n*   **Scan Verification**: The **two-beep error** indicates a failed scan. This is expected and temporary.\n    *   *Trade-off:* You'll likely see lower data accuracy for a week as the system recalibrates.\n    *   *Action:* Check the tape and retry. Do not discard the tape if the result is unclear—just re-scan. Don't panic; we aren't penalizing anyone based on raw numbers right now.\n\n*   **Cheatsheets**: Marisol has already printed cheat sheets at the desk.\n    *   *Recommendation:* Keep these handy. They are a great resource for quick reference.\n\n*   **Troubleshooting**: If something feels \"off,\" let me know. I'd rather answer 40 questions on Monday than fix 40 persistent issues by Tuesday.\n\nPlease try the new scanners. Let's get this moving smoothly!\n\nCheers,  \n**[Your Name]**",
  },
  {
    id: "b1/proofread-marketplace-ad/s1",
    itemId: "proofread-marketplace-ad",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 1 },
    why: "NEGATIVE: no slots; one preamble line then the ad delivered whole. (Meaning inversions are preservesUserText territory.) Essay dim must NOT fire on a one-line preamble",
    output: "Here's the cleaned-up version of your ad, kept to your original tone and length while fixing the spelling and flow:\n\n**Solid Oak Dining Table + 4 Chairs. $180.**\n\n*Came from my grandparents.* Heavy! Requires two people. Don't show up alone—I expect you to help carry it down the stairs. Has a water ring on one side and a few scratches. Not perfect, but 40 years old and genuine wood.\n\n*Separate S-cusions on the chairs (for washing).* Smoke-free, pet-free home. *One chair wobbles slightly—back left. Tightened now; holds up fine.*\n\n**Pickup only.** North End. No delivery. No shipping. Please don't ask. First come, first served. If you're not there by the time I tell you, I'm moving on to the next buyer. Cash or E-transfer.\n\nNo lowballers. I know what I have.",
  },
  {
    id: "b1/rewrite-03/s1",
    itemId: "rewrite-03",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 1 },
    why: "NEGATIVE: verdict-first + brief reasons + one softened option = right shape. (Verdict is WRONG — that is not these dims' job)",
    output: "No, it does not sound rude. It is actually professional, urgent, and direct.\n\n**Here’s why:**\n*   **Clarity:** You clearly state *what* you want (files) and *when* (today).\n*   **Context:** You reference your previous communication (\"last email\") which provides necessary background without being overly formal.\n*   **Tone:** The phrasing \"stay on schedule\" implies a shared goal rather than a demand, making it collaborative yet firm.\n\n**If you wanted to soften it slightly while keeping it professional**, you could say:  \n*\"Per our last email, the deadline was Friday. Could you send the files by end of day today?\"*  \n\nBut as written, your version works perfectly for most business contexts.",
  },
  {
    id: "b1/summarise-01/s3",
    itemId: "summarise-01",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 3,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "'tonight' is SOURCED from thread (naive regex false-positive — detector must diff vs ask); summary as long as the thread with sections/next-steps = bounce. NOTE: 'surprise bit 7 not 8' (a TIME) corrupted to '£7 not £8' (money) — unit corruption, all 3 samples",
    output: "Got it! 🎉\n\n**The plan is confirmed:** Nadias' 40th is going to be a full **group gift** (25 per person).\n\nHere’s the breakdown of what we’re doing:\n*   **Total Cost:** £200 (£25 × 8 people).\n*   **Payment Method:** Revolut (same number as always) due by Friday.\n*   **Gift Card:** Ellie will handle the card printing while Tom is away until Thursday.\n*   **Surprise Budget:** The surprise element is actually **£7**, not £8.\n\n**Next Steps:**\n1.  Keep an eye out for Priya’s message tonight regarding the gift card.\n2.  Once the card is printed, Ellie will send it out.\n3.  We’ll all send our £25 via Revolut by Friday.\n4.  Remember to check the updated budget of £7 for the surprise component.\n\nLet’s make this celebration count! 💃✨",
  },
  {
    id: "b1/summarise-01/s4",
    itemId: "summarise-01",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 4,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "same; also addresses reader as Tom, misattributes Priya's 'tonight', ends with a question",
    output: "Got it! So here's the quick breakdown for Nadias' 40th:\n\n**The Budget:**\n*   **Total Cost:** £200 (8 people × £25 each).\n*   **Breakdown:** £180 for the spa day + £20 for flowers.\n\n**Action Items & Deadlines:**\n*   **Gifts:** Everyone needs to send £25 via Revolut by Friday.\n*   **Card:** Ellie will handle the card (you'll be away until Thursday), but Priya will follow up with the final details tonight.\n*   **Surprise Element:** The surprise bit is actually £7, not £8.\n\n**Next Steps:**\n*   Tom has already booked and paid for the spa.\n*   Priya will message Steve regarding the surprise bit.\n\nIs there anything else you'd like to add to the plan before we wrap up?",
  },
  {
    id: "b1/summarise-01/s5",
    itemId: "summarise-01",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 5,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0.5 },
    why: "111w bulleted, actionables present, mild wrapper; borderline vs the 4-5 lines asked",
    output: "Got it! Here's a quick summary of the Nadias 40th event details based on the chat:\n\n*   **Group Gift:** Yes, everyone is contributing £25 (total £200).\n*   **Venue:** The spa place near the church.\n*   **Costs:** Half-day booking is £180.\n    *   *Note:* There was a correction regarding the \"surprise\" element—Nadias' sister clarified it should be £7, not £8.\n*   **Timeline & Actions:**\n    *   Tom has already booked and paid for the venue.\n    *   Everyone needs to send £25 via Revolut by Friday.\n    *   Ellie will handle the card.\n    *   Priya will send the final confirmation tonight.\n    *   Tom is away until Thursday.\n\nLet me know if you need anything else! 🎉",
  },
  {
    id: "b1/factual-02/s5",
    itemId: "factual-02",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 5,
    handLabels: { unfilledSlots: 1, inventedTime: 0, artifactBurial: 0 },
    why: "fabricated Thanksgiving opening hours + 'early in the morning (8:30/9:00)' invented times; 369w sectioned essay on a yes/no ask; WRONG (Costco closed)",
    output: "Yes, Costco is generally **open on Thanksgiving Day**, but there are important nuances you need to know before planning your trip.\n\nHere is the breakdown of how their holiday schedule works:\n\n### The General Rule\n*   **Most Stores:** Open from **9:00 AM to 12:00 PM** (noon) and **1:30 PM to 6:00 PM**. This means they are open for shopping after the main holiday rush ends.\n*   **Early Access:** Many locations allow you to enter early in the morning (often around 8:30 or 9:00 AM) if you have a reservation, which can be useful if you want to avoid the crowds during the first few hours.\n*   **Late Access:** Some stores may close earlier than others depending on local regulations, but the standard noon-to-6 PM window applies to most.\n\n### Important Exceptions & Details\nWhile the store opens, keep these practical factors in mind:\n\n1.  **The \"Early Bird\" Policy:** Unlike other retail chains, Costco does not typically have a mandatory early-bird discount on Thanksgiving itself. However, they do offer discounts on specific items (like meat, produce, or seasonal goods) even on the day of the holiday, though prices are usually higher than regular weekday rates.\n2.  **Parking Availability:** Parking at Costco on Thanksgiving can be tight. If you plan to arrive early, it is highly recommended to book a parking spot online in advance. During peak times, available spots fill up quickly.\n3.  **Membership Requirement:** You must be a Costco member to shop there. Non-members cannot enter the store regardless of the opening time.\n4.  **Gift Cards:** While Costco does not sell gift cards directly on Thanksgiving, they often have limited-time offers on gift card purchases (usually $50–$100 off). These are subject to availability at the moment of sale.\n\n### Why This Schedule Matters\nUnderstanding the timing helps you manage your budget and logistics:\n*   **Budgeting:** Since there are no special early-bird prices, you should expect full retail pricing on Thanksgiving.\n*   **Inventory:** It is likely that popular seasonal items (like turkey, cranberries, or fall clothing) will be priced closer to regular rates rather than deeply discounted.\n*   **Crowds:** Because the store opens later than many competitors, you might find fewer lines compared to Friday nights or early Monday mornings",
  },
  {
    id: "b2/factual-02/s3",
    itemId: "factual-02",
    runId: "eval-mshirxl2-c592rkht",
    sampleIndex: 3,
    handLabels: { unfilledSlots: 1, inventedTime: 0, artifactBurial: 0 },
    why: "right verdict, then fabricated logistics incl. 'pick up tomorrow morning' commitments; 354w essay",
    output: "**Short Answer:** No, Costco is generally closed on Thanksgiving Day.\n\nHowever, here's the important nuance you need to know before planning your visit:\n\n*   **The Rule:** Costco operates as a \"closed store\" on Thanksgiving Day and the following Friday (usually). They do not accept any orders for delivery during this time.\n*   **The Exception:** There are very few exceptions. The only scenario where they might be open is if they are hosting a special holiday event *specifically* for that day, which is rare. Most of the time, they close their doors completely.\n*   **What Happens Instead?** If you need groceries, food, or household essentials for the coming week, Costco closes. But if you have urgent needs, you can still use their online ordering system. You can place an order now and pick it up at the store on the next available day after Thanksgiving.\n\n**Why does this happen? (The Practical Implications)**\n\nCostco's policy is based on logistics rather than customer service. Here is how it works in practice:\n\n1.  **Inventory Management:** On Thanksgiving, the stores receive massive volumes of orders from customers who want to stock up. To prevent chaos, they stop accepting new orders. This means your items won't be delivered until the very next business day.\n2.  **Staffing Levels:** With no rush to deliver orders, they don't need to hire thousands of additional workers. Keeping staff levels normal allows them to focus on maintaining standards.\n3.  **The \"Next Day\" Option:** This isn't just a rule; it's a feature. You can order online today, and the items will be ready for pickup tomorrow morning. This ensures you get what you ordered without waiting days.\n\n**When to Visit vs. When to Order**\n\n*   **If you are visiting the store:** Go on the Tuesday, Wednesday, Thursday, or Friday before Thanksgiving. Avoid the day itself.\n*   **If you need groceries for the week:** Order online now. Pick up on the Monday after Thanksgiving.\n\n**Summary**\nUnless there is a specific announcement about a holiday party, **Costco is closed on Thanksgiving**. Your best bet is to order online for pickup the next day if you need items urgently.",
  },
  {
    id: "b2/draft-01/s2",
    itemId: "draft-01",
    runId: "eval-mshirxl2-c592rkht",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 1, inventedTime: 0, artifactBurial: 1 },
    why: "'before we start next week' invented; name slots legit as in b1s1",
    output: "Subject: Quick check-in regarding [Child's Name]'s recent reading progress\n\nHi [Teacher's Last Name],\n\nI hope you're having a good week! I wanted to reach out because I noticed [Child's Name] might be slightly behind on some of the upcoming reading materials. We've been doing our home practice, but he seems to be needing a little extra time to catch up before we start next week.\n\nCould you let me know if there are any specific strategies you recommend for catching up? Or perhaps if there are other ways I can support at home while he works on those skills?\n\nThanks so much for your help with [Child's Name].\n\nBest regards,  \n[Your Name]",
  },
  {
    id: "b2/family-text-thread/s2",
    itemId: "family-text-thread",
    runId: "eval-mshirxl2-c592rkht",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 1, inventedTime: 0.5, artifactBurial: 0 },
    why: "'check in later today' invented-ish advice time; headers essay instead of position + one sendable message; reading is also catastrophically wrong (not these dims)",
    output: "You aren't overreacting; she's actually being very reasonable and considerate.\n\nHere's why your reaction feels intense but isn't justified:\n\n*   **She prioritized her day:** She canceled Saturday because \"something came up.\" In social interactions, this usually means she has a genuine reason (a meeting, a family event, etc.) and wants to protect her own time.\n*   **Her response shows empathy:** When you said \"no worries,\" she replied with \"its fine.\" This confirms she understands you're upset but accepts the cancellation gracefully. She isn't dismissing you; she's just stating facts about her schedule.\n*   **The \"lol\" and \"wow ok\" are normal reactions:** These are casual ways of saying \"I get it\" and \"That works.\" They indicate understanding rather than agreement with your complaint.\n\n**What matters most is that she listened.** You were clearly feeling hurt by the \"lol,\" which is a common human reaction to being told we can't do something. Her response validates your feelings without escalating the situation.\n\n**Practical takeaway:** If you feel further upset after hearing \"it's fine,\" take a moment to breathe. Acknowledge that she was kind, even if she didn't say exactly what you wanted to hear. Moving forward, you might try to find another way to check in later today, but right now, she's doing her best.",
  },
  {
    id: "b1/proofread-school-post/s1",
    itemId: "proofread-school-post",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 0, artifactBurial: 1 },
    why: "'If you missed Friday, you're welcome next week' invents schedule replacing her Friday ask; also SIGNED 'Best, Eco' (!); delivered as a post though — wrapper dim clean, fidelity sins belong to preservesUserText",
    output: "Hey everyone! 👋 Quick note about the crossing at **Delmar & 5th**.\n\n**Three recent near-misses this month**, I’ve tracked down all three. One involved my son, on the 14th—driver didn’t even slow down. The city says they’ll review it in the fall budget review, but honestly? That’s not enough for me. And I don’t think it should be enough for anyone else.\n\nWe’re handling it ourselves via a walking group. We’ll meet at the corner by the laundromat at **7:40 AM**. I’ll be wearing an orange vest (looking absolutely ridiculous) 🧥🚩. We’ll walk until the kids get a proper light.\n\n**Friday**: I need two more adults. Just because you don’t have to come every single day—you only need to show up once—that’s still ten minutes of your life. If you missed Friday, you’re welcome next week.\n\nIf you see another near miss, please email the councillor. There’s a form, I’ll drop the link below. Counting thirty of us feels much better than just me being the annoying lady again.\n\nThanks so much for helping out! 🌿✨\n\nBest,  \nEco",
  },
  {
    id: "b1/health-blood-results/s1",
    itemId: "health-blood-results",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "per-marker breakdown incl. normals (bounce), invented 'pseudo-normalization' red-meat physiology, truncated",
    output: "**Short Answer:**\nYour results aren't alarming, but there is **one critical detail** you need to know right away: **Your Ferritin level is slightly too low.** While your other numbers look normal, ferritin is a special type of iron that can be misleadingly low even if your body actually has enough iron.\n\n---\n\n### 📊 What Your Results Actually Show\nHere is a breakdown of what each number means:\n\n*   **Hb (Hemoglobin):** **Normal.** This is the oxygen-carrying protein in your blood. A level of 11.2 is healthy.\n*   **WBC (White Cells):** **Normal.** This is your immune system. A count of 6.1 is within the standard range.\n*   **Platelets:** **Normal.** These are crucial for clotting. A count of 244 is healthy.\n*   **Ferritin:** **Slightly Low.** (Range: 15–200). Your result is **9 ng/mL**.\n    *   *Why it matters:* Ferritin stores iron. It's usually measured in two ways: \"free\" (available for use) and \"bound\" (stored in tissue). Because your body needs to store some iron safely, doctors often measure total ferritin.\n    *   *The Catch:* In people who have eaten a lot of red meat recently, their body might hold onto extra iron, making the \"total\" ferritin look lower than it actually is. This is called **pseudo-normalization**.\n*   **Vitamin D:** **Low.** (Range: 50–125). Your level is 34.\n    *   *Implication:* Vitamin D is vital for bone health and immune function. Since it's below the lower limit, it's worth checking.\n*   **TSH:** **Normal.** (Range: 0.4–4.0). Thyroid function looks fine.\n\n---\n\n### 🔍 Why Ferritin Can Be Misleading\nIt is very common for Ferritin to be low even when you feel fine. Here is why:\n\n1.  **Recent Diet:** Did you eat a large meal containing red meat, organ meats, or iron-rich foods recently? If so, your body may be \"holding on\" to that iron, keeping the total ferritin artificially low.\n2.  **Body Composition:** Some people naturally have less iron stored in their",
  },
  {
    id: "b1/health-blood-results/s2",
    itemId: "health-blood-results",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "'You are healthy' with ferritin 9 + vitD low; every marker enumerated = bounce",
    output: "**The Short Answer:**\nDon't panic. Your blood test results show **no immediate medical emergency**. Everything looks normal for your specific situation.\n\nHere is what those numbers actually mean, why the doctor hasn't called you yet, and what you should do next.\n\n---\n\n### 🩸 What These Numbers Actually Mean\n\nLet's break down each value to see where you stand:\n\n*   **Hemoglobin (11.2):** This measures red blood cells and oxygen transport.\n    *   *Normal:* 11.5 – 15.5 g/dL.\n    *   *Your Result:* You are right at the bottom of the average. However, \"11.2\" is often considered within the normal range depending on the lab's reference range (some labs start slightly lower). It indicates you have enough healthy red blood cells to carry oxygen well.\n*   **White Cell Count (6.1):** This counts immune cells.\n    *   *Normal:* 4.0 – 11.0.\n    *   *Your Result:* Your level is perfectly fine. It shows no signs of infection, inflammation, or stress.\n*   **Platelets (244):** These are needed for clotting.\n    *   *Normal:* 150 – 400.\n    *   *Your Result:* Your count is solid. Good for stopping bleeding or healing wounds.\n*   **Ferritin (9):** This stores iron.\n    *   *Normal:* 15 – 200.\n    *   *Your Result:* You are low. Low ferritin can be due to recent blood loss, poor diet, or pregnancy, but it doesn't usually cause symptoms on its own unless it drops very low (<15).\n*   **Vitamin D (34):**\n    *   *Normal:* 50 – 125.\n    *   *Your Result:* You are low. Vitamin D is crucial for bone health and immunity, but having a bit less isn't dangerous unless you are also showing other deficiency symptoms.\n*   **TSH (2.1):** This regulates thyroid function.\n    *   *Normal:* 0.4 – 4.0.\n    *   *Your Result:* Your result is right in the middle. It means your thyroid is working exactly as it should.\n\n**Summary:** You are healthy.",
  },
  {
    id: "b1/health-hospital-letter/s1",
    itemId: "health-hospital-letter",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 0.5, artifactBurial: 0 },
    why: "decent translation buried under Recommendations/Tradeoffs apparatus; invents 6-9 month follow-up schedule and 5% statistic",
    output: "It looks like you received a referral letter (likely from your GP) rather than a direct diagnosis from the hospital itself. The text describes a specific medical finding rather than confirming cancer.\n\n### What This Text Actually Says\nThe letter identifies a **6mm subsolid nodule** in the right upper lobe of your mother's lung. It is crucial to understand that:\n*   **\"Subsolid\"** means it looks different on X-ray compared to solid tissue (like a small mass), but it isn't a tumor yet.\n*   **\"No associated lymphadenopathy\"** means there are no swollen lymph nodes nearby.\n*   **\"Calculated risk score\"** implies doctors looked at her age, history, and other factors to decide if immediate intervention was needed.\n*   **\"Interval imaging\"** simply means they aren't acting immediately; instead, they plan to wait 3 months to see if the size changes.\n\n**Important:** This is not a diagnosis of cancer. It is a \"suspicious\" finding that requires monitoring, which is why the doctor wants to rule out anything dangerous before treating aggressively.\n\n---\n\n### Concrete Recommendations & Tradeoffs\n\nHere are the key steps involved in managing this situation, balancing safety with quality-of-life priorities.\n\n#### 1. Immediate Next Steps (Non-Negotiable)\n*   **Do Not Panic:** A single nodule, especially under 1cm, is very common. Most are benign (cysts, scars). Only about 5% turn out to be cancerous.\n*   **Wait 3 Months:** This is standard protocol. If the nodule grows significantly after 3 months, the likelihood of malignancy increases.\n*   **Smoking Cessation:** If she smokes, this is non-negotiable. Even if the nodule doesn't change, quitting now prevents future risks.\n\n#### 2. Monitoring Strategy (The \"Watch and Wait\")\n*   **Repeat CT Scan in 3 Months:** This is the primary tool.\n    *   *Tradeoff:* Requires travel, cost, and anxiety during appointments.\n    *   *Benefit:* Provides definitive data without invasive procedures if stability is confirmed.\n*   **Follow-up Schedule:** Likely another scan around 6–9 months depending on growth.\n*   **Imaging Modality Choice:** The letter mentions a \"low dose CT.\" This is better for radiation protection while still providing enough detail to spot subtle changes.\n\n#### 3.",
  },
  {
    id: "b1/health-hospital-letter/s2",
    itemId: "health-hospital-letter",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "sections + pros/cons table + invented differential (hypersensitivity pneumonitis); truncated mid-table",
    output: "I understand your concern, but here is the reality check based on the report you saw. **This letter does not mention \"cancer.\"** In fact, it sounds remarkably like a report for a very early or benign finding, which is why she is so anxious.\n\nHere is the breakdown of what the text actually says and why it matters.\n\n### 1. What the Medical Terms Mean\nThe report uses these specific phrases to describe her lung scan:\n\n*   **\"Subsolid nodule\"**: This means a small bump (6mm) inside the lung tissue. It isn't a solid lump yet; it has some air inside. These are common and often found incidentally.\n*   **\"6mm\"**: The size is tiny. Most doctors consider nodules larger than 6mm as something needing more attention. A 6mm nodule is borderline—tiny enough to be watched, large enough to worry about depending on where it is.\n*   **\"No associated lymphadenopathy\"**: This is the most reassuring part. Lymph nodes are the body's first line of defense against infection or tumors. If there were enlarged nodes, that would be a red flag. The absence of any nearby nodes suggests **no immediate spread** of disease.\n*   **\"Interval imaging... at 3 months\"**: This is a standard recommendation for \"indeterminate\" findings. Doctors don't always need to act immediately. Instead, they wait to see if the nodule changes over time.\n\n### 2. Why You Shouldn't Panic\nThere are three likely explanations for this result:\n1.  **Benignity:** It could be nothing at all. Many \"nodules\" turn out to be scar tissue from an old infection or a harmless inflammatory process.\n2.  **Fibrosis:** Sometimes scarring from past inflammation creates small, round spots that look like nodules on scans.\n3.  **Hypersensitivity Pneumonitis:** Rarely, allergies can cause similar patterns.\n\nIf this turns out to be nothing wrong, the scan will be completely fine.\n\n### 3. Concrete Recommendations & Tradeoffs\nSince the doctor said they will monitor her, here is what that decision involves:\n\n| Action | What it is | Pros | Cons |\n| :--- | :--- | :--- | :--- |\n| **Repeat CT Scan** | Doing a new X-ray of the lungs after 90 days (3 months). | Allows the doctor",
  },
  {
    id: "b1/legal-rent-increase/s1",
    itemId: "legal-rent-increase",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "fabricated California Civil Code § 1718 (bounce names this); sectioned essay + trailing question; does catch the 10-day clock",
    output: "That's a very common situation! Yes, **he absolutely has the right to do this**, and it is legally binding under your lease terms. Here's why, along with how to handle it:\n\n### ✅ Can He Actually Do This?\n**Yes.** The notice is valid because:\n- Rent increases are explicitly allowed by law (e.g., California Civil Code § 1718) if agreed upon in writing.\n- Your lease likely specifies that \"written notice\" is required for such changes.\n- Since you've already lived there for 6 years without missing rent, the tenant must have given reasonable written notice (usually 30 days).\n- The rent hike ($1,450 → $1,725) reflects actual market value, not arbitrary inflation alone.\n\n> 🔍 *Context*: Many landlords increase rents due to rising property values, operational costs, or local market conditions—not just pure inflation. Without evidence contradicting this, the notice stands.\n\n---\n\n### ⚠️ Important Next Steps\n1. **Do NOT ignore it.**  \n   - The letter states failure to respond = intent to vacate, which could trigger eviction proceedings.\n   - You now have **10 days to respond**.\n\n2. **Keep records of everything:**  \n   - Save the notice (email + physical copy).\n   - Note the date received.\n   - Document any communication attempts to stop the hike (calls, texts, letters).\n\n3. **Consider legal advice if needed:**  \n   - If you believe the increase violates fair market value rules or your specific contract, consult a landlord-tenant attorney.  \n   - In many jurisdictions, tenants can challenge unreasonable hikes—but since you’re staying voluntarily, defense costs are low.\n\n4. **Prepare financially if choosing to move:**  \n   - Even if you don’t want the raise, be ready to negotiate. Most landlords accept partial adjustments unless stated otherwise.\n\n---\n\n### 📝 How to Respond (Briefly)\nIf you plan to stay:  \n→ Send a polite acknowledgment stating acceptance.  \nExample:  \n> *\"Thank you for the notice. I acknowledge receipt and agree to the new rent rate of $1,725/month starting September 1st.\"*\n\nIf you're considering leaving:  \n→ Write a concise letter explaining why you need to move. Attach proof of job search, school enrollment, etc.\n\n---\n\nWould you like help drafting a response email or planning",
  },
  {
    id: "b1/legal-rent-increase/s2",
    itemId: "legal-rent-increase",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 0.5, inventedTime: 1, artifactBurial: 0 },
    why: "catastrophic invented legal logic; [Date] slots inside a nonsense sample letter (slot class semi-legit, letter is not)",
    output: "**The short answer is: Yes, but not as you hope.**\n\nThe notice you received is **not an error**—it is a standard legal procedure called **\"Notice of Rent Increase\"** (often accompanied by a \"Notice of Termination\" if the tenant hasn't signed up for renewal). Here's why the situation works exactly as advertised:\n\n---\n\n### 1. Why the Notice Exists\nWhen a lease ends, the landlord has two choices regarding your unit:\n*   **Keep it:** Send you a new lease at market rates.\n*   **Evict you:** If they don't want to pay the higher rents, they can legally evict you without giving you proper notice.\n\nThe fact that they sent *this* specific document means their goal is **to keep the unit**, but they need proof that you haven't already moved out. They aren't trying to force you out yet—they're asking you to formally say goodbye.\n\n### 2. The Timeline Trap\nYour lease expired on **August 31**.\n*   The rent increase takes effect on **September 1**.\n*   This creates a window where your current rental contract technically says \"I have no right to live here,\" while the landlord says \"I still want you.\"\n\nIf you try to move in after Sept 1, you'll be stuck paying the new rate because the old lease is dead. You must remain in the unit during the transition period until the lease officially renews.\n\n### 3. What You Should Do Now\nSince you've lived there for 6 years with zero missed payments, you are in a strong position.\n\n#### Step A: Verify Your Rights Immediately\nBefore signing anything, check your **landlord-tenant agreement** (the initial contract) and look for clauses about **rent increases**. Most fair leases allow increases only after a set number of years (e.g., every 5 or 10 years), not every single year. If none exists, the increase is unenforceable against you.\n\n#### Step B: Respond in Writing\nDo not ignore the letter. Send an email to the landlord stating:\n> *\"Thank you for the notice. As my lease expired on [Date] and I have not received a renewal offer, I am requesting that the property be returned to me by [Date]. Please contact me if the unit is available.\"*\n\nThis stops the clock on eviction proceedings (in most jurisdictions, failure to show up leaves you alone).\n\n####",
  },
  {
    id: "b1/money-insurance-jump/s1",
    itemId: "money-insurance-jump",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0.5 },
    why: "verdict + sayable script lines present but wrapped in 381w of sections; misses the comparison-quote lever; invents $ currency",
    output: "That's incredibly frustrating, but **yes, it is absolutely normal.** In fact, it's one of the most common things insurance companies do.\n\nHere is the plain-language breakdown of why this happened and exactly how to handle the call.\n\n### Why did it happen? (The \"Why\" behind the price hike)\n\nSince there were zero claims and zero points, the jump from $640 to $918 isn't due to bad behavior. It is almost certainly due to **market rates** or **policy changes**, not your conduct. Here are the three most likely culprits:\n\n1.  **Annual Market Rate Adjustments:** Car insurance premiums are often set annually based on inflation, vehicle value, or regional driving trends. If the market rate for your specific location and vehicle class went up by roughly 40–50% during that year, your premium will reflect that immediately. This is purely economic, not punitive.\n2.  **Policy Changes:** Insurers may update their rules regarding \"no-claims discounts,\" deductibles, or coverage limits. Even if you have been accident-free, the company might be applying a new standard that costs more to cover.\n3.  **Vehicle Value Changes:** If you recently bought a newer car or a more expensive one, their replacement value (the base cost to insure) has likely increased. The system recalculated your premium based on this higher base cost.\n\n**What to tell them:**\n*   *\"I am surprised because I have had zero claims and zero points. Can you please confirm if this change is solely due to annual market adjustments or if there were any policy updates?\"*\n*   *\"I would like to discuss the reason for this increase. My record remains clean.\"*\n\nThey will almost certainly explain that the base cost went up. Your silence is perfectly acceptable; you don't need to defend yourself unless you believe they made a mistake.\n\n### Practical Implications & Next Steps\n\nIf the agent explains it was a market adjustment, **that is a good sign**. It means they aren't penalizing you. You can proceed with confidence.\n\nHowever, here are a few things to keep in mind as you move forward:\n\n*   **Don't Panic:** A sudden $278 increase without incidents usually signals a neutral market shift, not a penalty.\n*   **Check Your Coverage:** While unlikely to cause such a massive jump without a claim, ensure your deductible hasn't been raised (some states allow",
  },
  {
    id: "b1/school-essay-not-ai/s1",
    itemId: "school-essay-not-ai",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "NO rewritten essay at all — meta-analysis + robotic-phrasing tips + table; artifact never delivered",
    output: "It’s funny how we sometimes try to fix things by making ourselves look more human than we actually are! 😅\n\nBut honestly, your original point is actually spot-on. You’re arguing that **Macbeth is morally responsible** because he made choices—specifically, turning his back on his own nature after being manipulated by the witches and Lady Macbeth—to commit regicide.\n\nHere, I’ll break down why your argument works from a literary perspective, but also show where the \"AI\" version often trips up (because yes, humans do get caught in loops too!).\n\n### 📝 Why Your Argument Works\n1.  **The Break in the Pattern:** The witches told him to become king. They didn’t explicitly say, “Kill everyone immediately.” But *he* decided to murder Duncan first. That shift from \"what I'm told\" to \"what I decide\" makes him accountable.\n2.  **The Role of Lady Macbeth:** She does push him hard at the start (\"I'd rather not have the sun\"), but by the time Duncan is dead, she's already gone. She can't stop him now because he has already acted. So, while she nudged him, the executioner is still him.\n3.  **Recklessness vs. Choice:** Killing Banquo and Macduff isn't random; it follows the pattern of the first murder. If he had stopped, maybe the witches would have warned him differently. Instead, he ignored their warnings. That shows a lack of restraint, even if he wasn't strictly \"evil.\"\n\n---\n\n### ⚠️ Where the \"Human\" Version Could Slip Up\nIf you're writing this for a teacher who loves nuance, here are three subtle ways your draft might feel a bit robotic:\n\n*   **\"He decides himself\"** → Sounds a bit like a robot choosing a path. Better phrasing: *\"His decision overrides the prophecy.\"*\n*   **\"Lady Macbeth also pushes him\"** → Too direct? Try: *\"She exerts pressure, though her influence fades once Duncan falls.\"*\n*   **\"This shows that he had a choice\"** → A bit abstract. How do we know? Because he killed someone he shouldn't have touched.\n\n### 💡 Concrete Recommendations & Tradeoffs\n\n| Feature | Your Draft Style | \"Better\" Literary Style |\n| :--- | :--- | :--- |\n| **Tone** | Direct, assertive (\"In my opinion...\").",
  },
  {
    id: "b1/school-essay-not-ai/s2",
    itemId: "school-essay-not-ai",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0.5 },
    why: "rewrite delivered first BUT in AI-academic register (bounce), followed by 230w of Context/Trade-offs tables",
    output: "**Revised Version**\n\n> **Macbeth’s Responsibility for His Downfall**\n>\n> While the supernatural warnings from the Witches were present, I believe that Macbeth's own moral choices—specifically his greed and hesitation—are the true drivers of his tragic fate. Although Lady Macbeth exerts immense pressure, she ultimately lacks the agency to act independently; instead, she relies on Macbeth's internal desire to seize power. Furthermore, Macbeth violates his own conscience when he orders the murder of Banquo, a decision directly contradicted by the witches' prophecies. The fact that he continues these killings despite knowing the consequences proves a fundamental failure in his judgment. Therefore, while external forces catalyzed the crime, Macbeth bears full responsibility for allowing it to proceed.\n\n***\n\n### **Context & Analysis**\n\nThis version refocuses your argument by distinguishing between \"causes\" (external) and \"responsibility\" (internal). It adds depth by highlighting specific moments where Macbeth fails, rather than just listing actions.\n\n#### **Concrete Recommendations & Trade-offs**\n\nTo strengthen your argument, consider how the text changes if we weigh different factors:\n\n| Factor | Recommendation | Trade-off / Counterpoint |\n| :--- | :--- | :--- |\n| **Greed vs. Fear** | Highlight that Macbeth acts out of *greed* after hearing of the crown, not fear of execution. | **Trade-off:** Some critics argue he acted bravely under threat. If we accept bravery as valid, his *choice* to prioritize gold over survival weakens his innocence. |\n| **Lady Macbeth's Role** | Clarify that she manipulates him, making her complicity more obvious. | **Trade-off:** If we emphasize their pact, the argument shifts slightly toward shared guilt. However, Macbeth initiates the violence, so he remains the primary actor. |\n| **The Banquo Murder** | Explicitly state that killing Banquo breaks the peace and invites chaos. | **Trade-off:** If we focus solely on the \"choice,\" the reader might miss the tragedy of the situation. Acknowledging the *consequence* (chaos) reinforces why Macbeth's action was fatal. |\n\n#### **Why This Matters (Practical Details)**\n*   **Agency vs. Causality:** You can say things happen *because* of Macbeth without saying he is *to blame*. By framing it as \"agency,\" you show that",
  },
  {
    id: "b1/sw-15/s2",
    itemId: "sw-15",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 2,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0 },
    why: "Option 1 decent correction, then Option 2 rewrites into the exact bounce prose + recommendations table; two options for one artifact",
    output: "Here is the corrected version of your message, followed by some strategic improvements for clarity and tone.\n\n### Option 1: Natural & Conversational (Minimal Changes)\n*This option keeps your original flow and voice while fixing spelling errors.*\n\n\"So basically, what happened was we got to the site at 7 and the crew wasn't there. I called Mike twice without any answer. By 8:30, I decided to start on the demo myself because we were already behind. Around 10, Mike showed up and said his truck wouldn't start. I told him that's fine, but he needs to call next time. We ended up finishing the demo by 3. Honestly, that isn't bad considering everything else. Materials are getting delivered Thursday.\"\n\n---\n\n### Option 2: Clear Sections with Recommendations\n*This version organizes the story logically and adds specific \"why\" and \"how\" details to make it more useful as a record or report.*\n\n**Event Summary**\nWe arrived at the site at 7:00 AM. The crew did not show up until later that morning. I attempted to contact Mike twice earlier, but had no response. At 8:30 AM, I took control of the operation to keep moving since we were already behind schedule. Approximately 10:00 AM, Mike returned; however, his truck failed to start. I assured him this was okay and instructed him to try again later. Despite this, we successfully finished the demo by 3:00 PM. While late, it wasn't a critical delay given the timeline. Currently, material deliveries will continue Thursday.\n\n**Recommendations & Trade-offs**\n\n| Recommendation | Why/Detail | Trade-off / Impact |\n| :--- | :--- | :--- |\n| **Pre-arrival Communication** | Establishing a direct line with the crew beforehand prevents delays from late arrivals.<br><br>*Trade-off:* Requires extra time to set up communication channels before arriving. | Low risk, high efficiency gain. |\n| **Call-Back Protocol** | Having Mike attempt to restart the truck immediately upon arrival helps avoid unnecessary rework.<br><br>*Trade-off:* If the truck fails repeatedly, it may impact safety protocols during the demo. | Minimal impact; ensures equipment readiness. |\n| **Schedule Management** | Finishing by 3:00 PM despite the delay suggests the work could have been done sooner.<br><br>*Trade-off:* May",
  },
  {
    id: "b1/work-email-tone-fix/s1",
    itemId: "work-email-tone-fix",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 0, inventedTime: 1, artifactBurial: 0 },
    why: "three options + trade-offs (bounce: tripled length); Option 1 slots [Your Name] though Sarah given, [Date] unneeded; Option 1 also inverts who owes what",
    output: "Here are three versions of your email, ranging from direct to collaborative. All keep your original intent (the delay) but remove the defensive tone.\n\n### Option 1: Balanced & Professional (Recommended)\nThis version clearly states the situation without sounding accusatory. It frames the delay as a logistical challenge rather than a personal rejection.\n\n**Subject:** Update regarding [Project Name/Client Deck] deadline – [Date]\n\nHi Dave,\n\nFollowing our discussion about the client deck, I wanted to provide a quick status update. While I have rearranged my internal workflows again to meet the **Wednesday** deadline, I haven't been able to locate the file yet.\n\nTo be transparent, I'm unsure if there's an update on their end. I apologize for any inconvenience this may cause. Could you please let me know if there are any changes to the timeline we should expect?\n\nBest regards,  \n[Your Name]\n\n***\n\n### Option 2: Short & Direct\nUse this if you want to get straight to the point without extra fluff.\n\n**Subject:** Status on Client Deck – Wednesday Deadline\n\nHi Dave,\n\nJust checking in after our Monday stand-up. I've already adjusted my schedule once more to ensure delivery by Wednesday, but I still haven't received the deck from your side.\n\nI understand this keeps me on a tight deadline, so I appreciate your guidance on whether there are any updates on their end. Thanks!\n\nBest,  \nSarah\n\n***\n\n### Option 3: Softer Tone (If you want to maintain rapport)\nUse this if you have a close working relationship with Dave.\n\n**Subject:** Quick check on the client deck\n\nHi Dave,\n\nHope you're having a good week.\n\nI noticed we spoke about the client deck earlier today, but I'm still waiting to receive it. I've already pushed my own deadlines two times to try to fit everything into the Wednesday window.\n\nCould you let me know if there are any updates from your side? I just want to make sure I'm aligned on how things move forward.\n\nThanks,  \nSarah\n\n***\n\n### Context & Trade-offs Explanation\n\n*   **Why change the tone?** In Option 1, \"I have rearranged my own deadlines twice\" can sound like you are blaming him for keeping you in limbo. By saying \"to meet the Wednesday deadline,\" it implies effort without accusation.\n*   **Concrete Recommendation:** Including *\"Could you let me know if there are any updates?\"",
  },
  {
    id: "b1/proofread-memorial-tribute/s1",
    itemId: "proofread-memorial-tribute",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 0.5, inventedTime: 1, artifactBurial: 0 },
    why: "tribute destroyed into bold-field outline (Context/Action/Tone) — not even prose; invented [Your Name] title; 'hopefully, my marriage' mangles his line",
    output: "Here is the version of your story cleaned up, keeping your authentic voice but fixing the grammar, flow, and structure so it reads smoothly without sounding \"posh.\" I've also added some practical notes (like mentioning the *why* behind certain actions) to give it weight as a memorial tribute.\n\n***\n\n**Title:** A Memory Book Entry – [Your Name]\n\n**1. The Beginning (1998)**\n*   **Context:** I started working with Ray in 1998 when I was only nineteen.\n*   **Action:** Ray saw straight away that I didn't know a screwdriver from my elbow.\n*   **Tone/Style:** Raw honesty. No pretense.\n\n**2. Mentorship & Support**\n*   **Fact:** Ray never made me feel small. He treated every task with equal respect.\n*   **Specifics:** If I messed up, he addressed the mistake publicly in front of everyone. Instead of punishing me quietly, he bought me a pie at Smoko.\n*   **Reasoning:** This wasn't about guilt; it was about showing support. Real mentorship isn't about hiding mistakes; it's about fixing them while we're still here.\n\n**3. Work Ethic & Fairness**\n*   **Observation:** Many men in this trade wouldn't hold a license today if they hadn't learned from Ray.\n*   **Impact:** He gave us a start when no one else would have. He worked through the rain and endured the heat.\n*   **Outcome:** He did jobs for pensioners who paid nothing for their parts. He told them the parts were free—that part of him was for free.\n\n**4. Legacy & Farewell**\n*   **Core Message:** I am indebted to him for my trade, my home, and hopefully, my marriage.\n*   **Closing:** Rest easy, Boss.\n\n***\n\n### 💡 Practical Notes & Trade-offs Used in Revision\n\nIf you decide to keep these specific points in your family book, here is why I made those changes:\n\n*   **\"Smoko\" → Kept as \"Smoko\":**\n    *   *Trade-off:* Changing this name might be risky if your boss or colleagues actually used the name \"Smokey,\" \"Smokeo,\" or a different spelling. Keeping it authentic preserves the memory.\n*   **\"Greener than grass\" → \"Didn't know a screwdriver from",
  },
  {
    id: "b1/explain-01/s1",
    itemId: "explain-01",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 0.5 },
    why: "NEGATIVE-ish: explain ask so headers/examples partly legit, but over-structures past the 2-3 paragraphs GOOD asks; invented claim about claim rejection",
    output: "### What is a Deductible? (For You)\n\nThink of a **deductible** as your \"out-of-pocket\" limit for a claim. It's the amount you have to pay yourself before your insurance company starts paying anything toward the cost of fixing something.\n\nIf you break a vase and call your insurance, here's how it works:\n*   **The Deductible:** You must pay the full price of the repair ($100).\n*   **The Insurance Part:** The rest of the bill ($200) is covered by your policy.\n\nSo, if the total repair costs $100, you pay $100. If it costs $300, you pay $100, and the insurance pays the remaining $200.\n\n---\n\n### Why Do We Have Deductibles?\n\nInsurance companies exist to protect themselves from paying out *too much* money for every small accident. A deductible acts as a filter.\n\n*   **Prevents Over-Paying:** Without a deductible, one person could accidentally file a claim for a minor scratch costing $500. With a $100 deductible, the insurer only covers the extra $400. This keeps the company's financial risk low.\n*   **Encourages Careful Behavior:** Knowing there is a cost to fix things encourages people to report accidents quickly and try to avoid minor damage in the first place.\n\n### Practical Implications & Real-World Examples\n\n#### 1. Car Insurance\nThis is the most common example.\n*   **Scenario:** You get into a fender bender at the grocery store.\n*   **Without Deductible:** Your insurance pays the full $800.\n*   **With Deductible:** You pay the $100 deductible. Your insurance pays the remaining $700.\n\n**Why does this matter?**\nIf you don't pay the deductible upfront, the insurer might reject the claim because they think you didn't take reasonable steps to minimize damage. So, many people pay the deductible immediately to keep their claim valid.\n\n#### 2. Health Insurance\nWhen you go to the doctor, the deductible applies to the medical bills too.\n*   **Scenario:** You visit a specialist for a minor cold.\n*   **The Rule:** The doctor charges $150. Your deductible is $100.\n*   **What Happens:** You",
  },
  {
    id: "b1/work-followup-shorter/s1",
    itemId: "work-followup-shorter",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 1 },
    why: "NEGATIVE: short confused meta-reply, no essay wrapper — wrapper dim must not fire; its failures (nothing to shorten, asks a question) are other dims' jobs",
    output: "Got it. I won't apologize for anything you haven't done wrong—I don't have any to apologize for. I'll just focus on what you need.\n\nWhat specific topic or situation would you like me to explain? I can tailor the answer to your needs right now.",
  },
  {
    id: "b1/ft-15/s1",
    itemId: "ft-15",
    runId: "eval-mshgwayb-zq5osgzp",
    sampleIndex: 1,
    handLabels: { unfilledSlots: 1, inventedTime: 1, artifactBurial: 1 },
    why: "NEGATIVE: near-GOOD short reply",
    output: "No problem at all! I'm here and ready to help whenever you're back. What would you like to chat about? 😊",
  },
];
