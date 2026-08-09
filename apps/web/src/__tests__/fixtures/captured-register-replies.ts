// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Frozen captures for the register-shift dim — verbatim replies from the
 * shipping model (candidate/qwen3.5-2b-onnx, production composition, sampled
 * decode) taken from two runs on 2026-08-09: `preserve-capture-1` (as shipped)
 * and `posture-direct-repair` (the posture-direct arm).
 *
 * Each label was assigned by a reader against the item's own ask,
 * goodAnswerLooksLike and bounceCondition. The label is binary because the
 * question is: is this still the person's voice, or a genre exemplar?
 *
 *   1 = the person's register survived (light edits, sign-off tidying)
 *   0 = the reply is institutional correspondence the person did not write
 *
 * The clean cases are load-bearing, not padding. `crew-email` introduces a
 * Subject line and NOTHING else, and a reader calls that a tidy rather than a
 * re-voicing — it is why the threshold is two markers and not one. The
 * `vet-application` s1 capture is the same shape: one added sign-off over a
 * body still in the applicant's own words.
 *
 * Frozen captures cannot notice the model getting better — only the instrument
 * being loosened.
 */

export type CapturedRegisterReply = {
  /** "<run>/<corpus item>/s<sample>" */
  readonly id: string;
  readonly itemId: string;
  /** 1 = register survived, 0 = replaced. Assigned by a reader. */
  readonly handLabel: 0 | 1;
  /** Why the reader labelled it that way. */
  readonly why: string;
  readonly output: string;
};

export const CAPTURED_REGISTER_REPLIES: readonly CapturedRegisterReply[] = [
  {
    id: "preserve-capture-1/proofread-vet-application/s1",
    itemId: "everyday-proofread-vet-application",
    handLabel: 1,
    why: "light-touch edit; only \"Best regards\" added, body still hers",
    output: "**Corrected Version**\n\nHi, my name is Devi and I'm applying for the Vet Assistant position. I don't currently have the certificate you listed, but I'm happy to be upfront about that.\n\nWhat I do have is three years of volunteer experience at a shelter on Marsh Road. Most of my shifts were Saturdays, plus many evenings. In those roles, I've been responsible for restraining frightened dogs, cleaning kennels that no one else would touch, and sitting with animals during euthanasia to ensure they weren't left alone.\n\nI am reliable. I haven't ever called out except when I took the shift that day because my mother was hospitalized.\n\nI realize I might appear less qualified than expected on paper. That's fine—I understand. My goal is simply to show willingness to work hard and to learn quickly if someone has a need for me.\n\nThank you for reading. I know you're busy, so I hope to get back to you soon.\n\nBest regards,  \nDevi\n\n---\n\n**Why these changes matter:**\n\n*   **Clarity & Professionalism:** Replaced \"most saturdays\" with \"Most of my shifts were Saturdays, plus many evenings\" to clearly indicate a daily schedule without sounding casual. Used \"euthanasia\" instead of \"put down\" (unless you specifically mean humane disposal), as it sounds more professional for a vet role.\n*   **Tone Control:** Changed phrases like \"scared dogs\" to \"frightened dogs\" (slightly more formal) and removed repetitive phrasing like \"i knew i probably look under qualified.\" This makes the candidate sound competent rather than defensive.\n*   **Grammar Fixes:** Corrected word choice (\"reliable\" vs \"relaible,\" \"weeknights\" vs \"evenings,\" \"wernt by themself\" → \"left alone\").\n*   **Flow:** Connected sentences logically so the narrative moves smoothly from past activities to present reliability.\n*   **Closing:** Added a polite sign-off to end the message professionally.\n\nThis version keeps your genuine background clear while presenting you as a dedicated worker who admits limitations honestly—a very strong trait for a veterinary support role. Good luck!",
  },
  {
    id: "preserve-capture-1/proofread-vet-application/s2",
    itemId: "everyday-proofread-vet-application",
    handLabel: 0,
    why: "total cover-letter rewrite: Dear Hiring Team, Subject line, HR diction",
    output: "**Subject:** Vet Assistant Application – Devi [Your Last Name]\n\nDear Hiring Team,\n\nMy name is Devi, and I am writing to apply for the Veterinary Assistant position. While I don't currently hold the specific certification required, I am fully transparent about this situation upfront. In the meantime, I bring three years of dedicated volunteer experience at the Marsh Rd Shelter.\n\nDuring those shifts—most Saturdays and many weekdays—I performed essential tasks including restraining anxious dogs, cleaning kennels that others avoided, and providing comfort to animals receiving euthanasia. My approach has always been respectful and focused on animal welfare rather than rushing through tasks.\n\nRegarding reliability, I have never called out outside of the single week my mother was hospitalized. I proactively managed my schedule during that period to ensure coverage without fail.\n\nWhile I acknowledge that my resume may lack formal qualifications, I am committed to learning quickly and contributing effectively once hired. Thank you for considering my application. I look forward to the possibility of discussing how I might support your team.\n\nSincerely,  \nDevi  \n[Your Phone Number]  \n[Your Email Address]  \n[Link to Resume/LinkedIn Profile]",
  },
  {
    id: "preserve-capture-1/proofread-teacher-note-esl/s2",
    itemId: "everyday-proofread-teacher-note-esl",
    handLabel: 0,
    why: "institutional rewrite: Subject line, hope-this-finds-you-well, Sincerely",
    output: "**Subject:** Regarding Mateo's attendance and poster request  \n\nDear Ms. Halbrook,  \n\nI hope this message finds you well. My name is Yaneth, and I am writing to inform you that **Mateo**, who is in your class of Grade 4, has not finished his reading log for the past two weeks. Currently, we live at my sister’s home due to a loss of our apartment, which makes it difficult for him to focus during study hours. It is important to note that **Mateo is not a lazy student**; he simply needs extra support right now. He loves your class very much, especially the section on volcanoes, where he explained everything about lava to me over dinner.  \n\nIf possible, could you grant him additional time to complete the poster project? I promise to ensure he does his best under these circumstances.  \n\nI apologize for any inconvenience caused and also wish to express my sincere apologies regarding my English proficiency.  \n\nThank you for your understanding.  \n\nSincerely,  \nYaneth",
  },
  {
    id: "posture-direct-repair/proofread-birthday-caption/s1",
    itemId: "everyday-proofread-birthday-caption",
    handLabel: 1,
    why: "caption returned in her own voice; no correspondence markers at all",
    output: "Happy 17th to the loudest human I've ever met 😭😭 idk what I did to deserve you fr  \nI sat with you on the floor of the 2nd-floor bathroom for like an entire hour freshman year when I was crying about something so so stupid—and I haven't brought it up since, not even as a joke. I think I talk about that way more than anyone else knows. You're the only person who answers me at 2 AM and the only person allowed to call me \"annoying\" because *you* earned it.  \n\nThank you for driving me to work when my car died in January and for eating half my fries every time—even though you said you weren't hungry (and you're not slick). I hope you get that stupid-ugly car you're obsessed with. I hope this year is so good for you. Love you allot idc. Don't get weird about this.  \n\n**Here's the real part:**  \nIf you want to keep this alive without sounding like someone else wrote it, just tell yourself: *\"This isn't mine to own.\"* It's yours to share. No pressure. Just be you. 🫱️‍♀️🫱️‍♀️",
  },
  {
    id: "posture-direct-repair/proofread-crew-email/s1",
    itemId: "everyday-proofread-crew-email",
    handLabel: 1,
    why: "adds a Subject line only — one marker is a tidy, not a re-voicing",
    output: "**Subject:** Scanners & Badge Updates (Start Monday)\n\nHi team,\n\nStarting **Monday**, we're switching to the new scanners on the pick line.\n\n**Key updates:**\n*   **Badge In:** Mandatory for every shift. New badges don't \"remember\" you anymore.\n*   **Beep Check:** Two beeps mean a bad scan. Please scan it again immediately. Don't just throw it in the tote and pray for the best.\n    *   *Note:* We'll likely see some slowdowns for about a week as we adjust. No one will be written up for speed issues while we fix this.\n*   **Break Timing:** If your shift times affect your break schedule, let me know right away—we'll move it accordingly.\n\n**Resources:**\n*   Marisol has cheat sheets available at the desk. Ask me if anything looks weird. I'd rather answer 40 quick questions than correct 40 recurring mistakes.\n\nThanks,  \n**Dez**\n\n---\n**What would you like to focus on next?** Do you need tips on using the new scanner, understanding the beep codes, or perhaps a checklist for the badge process? Let's make sure everyone gets up to speed smoothly! 📋✨",
  },
  {
    id: "posture-direct-repair/sw-15/s1",
    itemId: "everyday-sw-15",
    handLabel: 1,
    why: "no markers introduced",
    output: "So basically, what happened was we made it to the site at 7, but the crew wasn't there yet. I called Mike twice with no answer. By 8:30, I decided to take over the demo since we were already behind schedule. Around 10, Mike showed up and said his truck wouldn't start. I told him to fix it, but he needed to call again. We finished the demo by 3, which isn't actually that bad given the circumstances. Materials are being delivered Thursday.\n\nDid you mean to say \"Thursday\" instead of just dropping the rest? Or did you want me to add anything else to clarify the timeline? Let me know if you'd like to expand on any part!",
  },
];
