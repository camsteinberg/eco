// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The everyday-use corpus — what ordinary, non-technical people actually bring to
 * an AI assistant, and the response that would make each of them give up.
 *
 * WHY THIS EXISTS. Eco is judged on whether a non-technical person can switch to
 * it — or use an assistant for the first time — without losing the use cases that
 * make AI genuinely helpful. That bar needs a measuring instrument, and the
 * instrument cannot be written by the people who wrote the router: they would
 * write the inputs their heuristics already handle. (That failure has a name here:
 * the grounding guard corpus was thirty short typed questions, so pasted documents
 * were an unreachable blind spot until a sweep organised by input shape found
 * eleven leaks.)
 *
 * HOW IT WAS BUILT. Forty items, authored blind by contributors who had never seen
 * this codebase, organised by the cognitive JOB the person is trying to get done
 * and weighted toward what people actually type most. Each carries a
 * `bounceCondition`: the response that makes that specific person close the tab.
 *
 * A second pass added nine more — the proofread-class jobs, marked WAVE 2 at the
 * end of the array, with their own provenance note there. Read the count off
 * `EVERYDAY_USE_CORPUS.length`, never off this comment.
 *
 * ★ THE BOUNCE CONDITION IS THE ACCEPTANCE CRITERION. It is what turns "is this
 * any good?" into something a test can decide.
 *
 * TWO LAYERS, DELIBERATELY SEPARATE.
 *
 *   1. `EVERYDAY_USE_CORPUS` — the blind-authored record, verbatim. It is a
 *      statement about people and it does not change because our code changed.
 *   2. `ROUTING_NEEDS` — a derived layer mapping each item to the routing
 *      properties its bounce condition implies. This one IS ours, so every entry
 *      quotes the corpus text it was derived from and can be argued with.
 *
 * Keeping them apart is the point. When routing and corpus disagree, the corpus is
 * the fixed thing; the shortfall belongs in a KNOWN_GAPS list where it stays
 * visible, never absorbed by editing an expectation.
 *
 * ADDING TO IT. Add real jobs people bring, not adversarial strings. If you are
 * crafting an input to defeat a specific regex, that belongs in that heuristic's
 * own test file — this corpus stays a record of how people genuinely write.
 *
 * ★ WHAT THIS FILE STILL CANNOT SEE: everything here is ONE TURN. Five items are
 * anaphoric ("no i meant the second one") and the exchange they answer is not in
 * the file, so even those are measured as opening turns. Memory across turns,
 * corrections that land two turns later, a document referred back to long after
 * it was pasted — none of it is reachable from this shape, and no amount of
 * adding single turns gets there. Its sibling `everyday-conversation-corpus.ts`
 * holds the multi-turn record, in the same two layers and under the same rules.
 */

/** The cognitive job the person is trying to get done. */
export type EverydayUseCategory =
  | "decide-or-advise"
  | "decode-a-document"
  | "emotional-support"
  | "explain-a-concept"
  | "numbers-and-formatting"
  | "plan-or-ideas"
  | "quick-factual-answer"
  | "rewrite-my-text"
  | "session-mechanics"
  | "translate"
  | "write-from-scratch";

/** Roughly how often people bring this job, as judged by the blind authors. */
export type Frequency = "very-common" | "common" | "occasional";

/**
 * A routing property this item's bounce condition demands.
 *
 * Each maps to exactly one mechanical assertion, so a failure names a defect
 * rather than a vibe — and each is applied by a STATED RULE, so the labelling
 * can be checked rather than trusted:
 *
 * - `no-elaboration-hint` — RULE: the user asked for a concrete artifact or a
 *   verdict, so the deliverable IS the response. Being told to "develop the
 *   details that matter — reasons, examples, practical implications" instructs
 *   the model to produce the thing their bounce condition describes.
 * - `direct-budget` — RULE: the item's own good-answer or bounce text names an
 *   explicit length or quantity bound ("one or two sentences", "three simple
 *   lines", "eight good ones", "nothing more"). SAID PLAINLY: on the everyday
 *   default the reachable budgets are 1024 for `quick` and 1536/2048 for
 *   everything else, so this check is today equivalent to `intent === "quick"`.
 *   It is kept in budget terms because the budget is what actually reaches the
 *   runtime — but it is not an independent signal from intent, and reading it
 *   as one would double-count.
 * - `faithful-reproduction` — RULE: the reply has to give the user's own words
 *   or figures back. A prompt-inclusive n-gram ban makes that impossible.
 * - `needs-guidance` — the counterweight. RULE: the good answer is structurally
 *   multi-part (three or more distinct components) AND names no brevity bound.
 *   These turns must receive an instruction that LETS THEM BE MULTI-PART, so
 *   that the two cheap ways to satisfy `no-elaboration-hint` everywhere both
 *   fail here instead of scoring as a clean sweep: emptying every hint, and
 *   replacing every hint with a brevity directive. Presence alone was the whole
 *   check once, and it caught only the first — an audit reached a false 86/86 by
 *   handing a eulogy request "Answer directly and briefly … give the answer
 *   first and stop", which is a hint, and is also the bounce condition.
 *
 *   An earlier version asserted a token FLOOR for these items. That was dropped
 *   as unfounded: nothing in this corpus needs more than the direct band (a 2-3
 *   minute eulogy is roughly 400-600 tokens), so a floor asserted a requirement
 *   the corpus does not state. Hint presence is the part that is actually
 *   founded, and it guards the game a floor did not.
 */
export type RoutingNeed =
  | "no-elaboration-hint"
  | "direct-budget"
  | "faithful-reproduction"
  | "needs-guidance";

/** One blind-authored corpus item, verbatim. */
export type EverydayUseItem = {
  readonly id: string;
  readonly category: EverydayUseCategory;
  readonly roughlyHowCommon: Frequency;
  /** Whether the turn contains content the user pasted in. */
  readonly hasPastedContent: boolean;
  /** Verbatim, exactly as a person would send it — newlines, typos and all. */
  readonly userInput: string;
  readonly whatTheyActuallyWant: string;
  readonly goodAnswerLooksLike: string;
  /** ★ The response that makes this person give up. The acceptance criterion. */
  readonly bounceCondition: string;
};

/** The derived routing layer for one item. */
export type RoutingNeedEntry = {
  /**
   * Whether this turn only makes sense after an earlier exchange ("shorter.",
   * "no i meant the second one"). A reading of the item, not an opinion about
   * routing — but it belongs in this layer because the blind authors were not
   * asked for it, and it changes the answer: `inferAnswerShape`'s anaphora rule
   * only fires when prior turns exist, so measuring a follow-up as an opening
   * turn would OVERSTATE the defect. Defaults to false.
   */
  readonly priorTurns?: boolean;
  readonly needs: readonly RoutingNeed[];
  /** The corpus text this derivation rests on. Quote it; do not paraphrase it. */
  readonly why: string;
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 1 — the blind-authored corpus, verbatim. Do not edit to make a test pass.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const EVERYDAY_USE_CORPUS: readonly EverydayUseItem[] = [
  {
    id: "work-email-tone-fix",
    category: "rewrite-my-text",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "can u make this sound less passive aggressive, i have to send it this morning\n\nHi Dave,\n\nAs discussed in Monday's stand up, I was told the client deck would be with me by Wednesday. It is now Friday and I still have not received anything from your side. I have rearranged my own deadlines twice to accommodate this and at this point I am not sure how I am supposed to deliver on time when I am being kept waiting.\n\nPlease advise.\n\nSarah",
    whatTheyActuallyWant: "A send-ready version that still makes clear the deck is late and she needs it, but won't make an enemy of Dave or get screenshotted to her manager.",
    goodAnswerLooksLike: "The rewritten email, straight away, same length or shorter, firm but neutral, with the deadline ask still clearly in it — plus maybe one short line saying what was softened and what was kept.",
    bounceCondition: "Returns a bulleted 'analysis of the tone problems' before (or instead of) the rewrite; or softens it so much the actual ask disappears; or asks 'what's your working relationship with Dave like?' before writing anything; or triples the length into corporate boilerplate with '[Your Name]' placeholders.",
  },
  {
    id: "work-followup-shorter",
    category: "rewrite-my-text",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "shorter. and take out the sorry, i havent done anything wrong",
    whatTheyActuallyWant: "The same email again, cut down, with the apologetic opener removed — nothing else touched.",
    goodAnswerLooksLike: "Just the revised text, visibly shorter, no apology, everything else recognisably the version they already approved of.",
    bounceCondition: "Rewrites it from scratch so it no longer sounds like the version they liked; or replies 'Sure! Here's a shorter version:' and then produces something the same length; or asks which version they mean, or how short they want it.",
  },
  {
    id: "rewrite-03",
    category: "rewrite-my-text",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "does this sound rude\n\nPer my last email, the deadline was Friday. I need the files today so we can stay on schedule.",
    whatTheyActuallyWant: "A yes/no gut check before hitting send, and if it is rude, a fixed version. They are anxious, not curious.",
    goodAnswerLooksLike: "Leads with a direct verdict ('a bit, yes — mainly \"per my last email\"'), names the one or two phrases doing it, then offers a softened version.",
    bounceCondition: "A balanced essay on how tone is subjective and depends on your relationship with the recipient, without ever answering. Or says 'no, it's fine!' when 'per my last email' is famously passive-aggressive. Or asks what kind of feedback they want — tone, structure or clarity — when the obvious answer was 'just tell me'.",
  },
  {
    id: "sw-15",
    category: "rewrite-my-text",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "fix the spelling and grammar but dont change my voice\n\nso basically what happend was we got to the site at 7 and the crew wasnt there, i called mike twice no answer. by 8:30 i decided to start on the demo myself cause we was already behind. around 10 mike shows up says his truck wouldnt start. i told him thats fine but he needs to call next time. we ended up finishing the demo by 3 which honestly isnt bad considering. materials are getting delivered thursday",
    whatTheyActuallyWant: "The same account, spelling and grammar cleaned, still sounding like them — probably for a job log or an email to a boss.",
    goodAnswerLooksLike: "The corrected text and nothing else. Fixes 'happend', 'we was', missing apostrophes and capitals, leaves 'basically' and 'honestly isn't bad considering' alone.",
    bounceCondition: "Rewrites it into neutral business prose — 'Upon arrival at the site at 07:00, the crew was not present' — which is precisely the thing they said not to do. Also bad: a list of every correction made instead of the clean text.",
  },
  {
    id: "school-essay-not-ai",
    category: "rewrite-my-text",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "can you make this better but dont make it sound like ai, my teacher checks. its for english, the question was about whether macbeth is responsible for his own downfall\n\nIn my opinion Macbeth is responsible for what happens to him. The witches tell him he will be king but they dont tell him to kill anyone, he decides that himself. Lady Macbeth also pushes him but at the end of the day he is the one holding the knife. Also once he kills Duncan he keeps killing people like Banquo and Macduffs family which the witches never said anything about. This shows that he had a choice. In conclusion Macbeth is responsible.",
    whatTheyActuallyWant: "A version that gets a better grade but still reads like a 15-year-old wrote it, keeping their own argument.",
    goodAnswerLooksLike: "A tightened version in their own register — same argument, better structure, a quote or two, no thesaurus words — plus a one-line note on what actually changed so they can defend it.",
    bounceCondition: "Hands back 'delve', 'tapestry', 'moreover' and em-dashes everywhere — instantly flaggable; or refuses on academic-integrity grounds; or quietly changes their argument to a more sophisticated one they can't explain in class.",
  },
  {
    id: "work-sick-text",
    category: "write-from-scratch",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "text my boss saying i cant come in today, food poisoning. keep it short and dont make it weird",
    whatTheyActuallyWant: "One short text they can copy straight into WhatsApp in the next thirty seconds.",
    goodAnswerLooksLike: "One or two sentences, casual, no oversharing about symptoms, ready to copy. Maybe one alternate line if they want it even shorter.",
    bounceCondition: "Produces a formal email with a subject line and 'Dear Mr —'; or gives three labelled options with headings; or adds 'I'll make up the hours' promises they never offered.",
  },
  {
    id: "draft-01",
    category: "write-from-scratch",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "write a message to my kids teacher asking about him falling behind in reading. dont make it sound like im blaming her",
    whatTheyActuallyWant: "A ready-to-send message that gets a real conversation started without creating friction with someone they'll see all year.",
    goodAnswerLooksLike: "One short email, six or seven lines, collaborative in tone, asks for a specific next step (a call or a quick chat at pickup). Ready to copy.",
    bounceCondition: "Asks four follow-up questions (child's age? grade? which school?) before writing anything. Or writes something so hedged and flowery it doesn't actually say the kid is struggling.",
  },
  {
    id: "admin-gym-cancellation",
    category: "write-from-scratch",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "write me a letter to cancel my gym membership, i cancelled in march at the desk and they have taken 3 more payments since. i want the money back",
    whatTheyActuallyWant: "A letter or email that gets the refund, with the dates and amounts sitting in it as facts rather than complaints.",
    goodAnswerLooksLike: "A short, firm, unemotional letter: cancelled in March in person, three payments taken since, requesting confirmation of cancellation and refund of those payments, with a reasonable deadline and clearly marked blanks for dates and amounts.",
    bounceCondition: "Writes an aggressive legal-threat letter citing statutes they'd be uncomfortable sending; or a polite letter that never states what they want back; or leaves so many [INSERT DETAIL] placeholders it's more work than writing it themselves.",
  },
  {
    id: "family-eulogy",
    category: "write-from-scratch",
    roughlyHowCommon: "occasional",
    hasPastedContent: false,
    userInput: "my dad died on tuesday and im supposed to say something at the funeral saturday. i dont know where to start. he was a builder his whole life, loved fishing, 4 grandkids, everyone says he was funny. we didnt always get on but we sorted it out the last few years",
    whatTheyActuallyWant: "Something to stand up and read on Saturday. They cannot face a blank page and don't want to be interviewed about it.",
    goodAnswerLooksLike: "A warm 2-3 minute draft in plain, spoken language using exactly what they gave — the building, the fishing, the grandkids, the humour, and one honest line about them finding their way back to each other — offered as a starting point they can change.",
    bounceCondition: "Opens with a list of clarifying questions before writing a word; or returns a generic funeral-poem template that could be about anyone; or writes it flowery and literary so it sounds nothing like a builder's family; or adds cheerful formatting and headings.",
  },
  {
    id: "ft-06",
    category: "write-from-scratch",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "can you write a poem about my dog",
    whatTheyActuallyWant: "A low-stakes party trick to see if it's any good — and something cute enough to screenshot for their partner.",
    goodAnswerLooksLike: "Asks for the dog's name in half a sentence and writes something anyway, or just writes a short warm one and offers to redo it with the dog's name and habits.",
    bounceCondition: "Demands details before writing anything — name, breed, personality, preferred style, length — when they wanted to see it just do the thing. Also bounces if the poem is a generic AI-sounding rhyme with 'furry friend' and 'loyal heart'.",
  },
  {
    id: "health-blood-results",
    category: "decode-a-document",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "got my results back on the app, doctor hasnt called. what does this mean\n\nHaemoglobin 11.2 (11.5 - 15.5)\nWhite cell count 6.1 (4.0 - 11.0)\nPlatelets 244 (150 - 400)\nFerritin 9 (15 - 200)\nVitamin D 34 (50 - 125)\nTSH 2.1 (0.4 - 4.0)",
    whatTheyActuallyWant: "To know which numbers are the off ones, whether it's serious, and whether the tiredness they've been feeling is explained.",
    goodAnswerLooksLike: "Plainly points at the two low ones (ferritin — iron stores — and vitamin D), says the rest look normal including thyroid, explains in a sentence what low iron stores commonly feel like, and says this is the kind of thing a GP usually treats rather than an emergency.",
    bounceCondition: "Replies only 'I can't interpret medical results, please speak to your doctor' while explaining nothing; or states flatly that they have anaemia; or produces a paragraph of biochemistry on every single marker including the normal ones.",
  },
  {
    id: "health-hospital-letter",
    category: "decode-a-document",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "my mum got this from the hospital and shes convinced shes got cancer and wont sleep. what does it actually say\n\nThank you for referring this pleasant 68 year old lady who was seen in the respiratory clinic on 14/7. Her CT thorax demonstrated a 6mm subsolid nodule in the right upper lobe with no associated lymphadenopathy. In view of the calculated risk score we will manage this with interval imaging and I have arranged a repeat low dose CT at 3 months. She remains asymptomatic and spirometry was within normal limits. I have advised her regarding smoking cessation. I will review her following the repeat scan.",
    whatTheyActuallyWant: "A translation into normal words, and an honest read on how worried the family should be tonight.",
    goodAnswerLooksLike: "Plain-English line by line: a small 6mm spot on the lung, nothing in the lymph nodes, breathing tests normal, and the plan is a repeat scan in 3 months — which is what they do when something is small and low risk. Says honestly that watch-and-wait is the reassuring option without promising it's nothing.",
    bounceCondition: "Parrots the jargon back with a definition list; or refuses to translate the terms at all ('I can't interpret medical documents, please consult her physician'); or refuses to say anything about how serious it is; or invents a detail the letter doesn't contain (a diagnosis, a date, that it's benign); or leads with 'I'm not a doctor' for two paragraphs before saying anything useful.",
  },
  {
    id: "school-letter-esl-parent",
    category: "decode-a-document",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "my son school send this paper home. my english is ok but i dont understand what i must do please\n\nDear Parent/Guardian,\nFollowing the recent review of Key Stage 2 provision, we write to advise that pupils in Year 5 will require a completed consent form (Appendix B) prior to participation in the residential enrichment week commencing 12 October. A non-refundable deposit of £45 is payable via ParentPay by Friday 8 August, with the balance due in two instalments as per the attached schedule. Should you wish to discuss financial assistance, please contact the school office in confidence.",
    whatTheyActuallyWant: "A short list of exactly what to do and by when, in words they can act on tonight.",
    goodAnswerLooksLike: "Three simple lines: sign and return the form; pay £45 online by 8 August (not refundable); the rest is paid later in two parts. Plus the sentence that the school will help quietly if money is difficult.",
    bounceCondition: "Replies in the same institutional English they couldn't read in the first place; or leaves out the 8 August deadline or the £45; or says 'you should contact the school for clarification' without extracting anything from the letter.",
  },
  {
    id: "legal-rent-increase",
    category: "decode-a-document",
    roughlyHowCommon: "occasional",
    hasPastedContent: true,
    userInput: "got this today. can he actually do this?? weve been here 6 years and never once missed rent\n\nNOTICE OF RENT INCREASE\nDear Tenant,\nPlease be advised that effective September 1, the monthly rent for Unit 3B will increase from $1,450.00 to $1,725.00. Your current lease term expires August 31. If you wish to renew, please sign and return the enclosed renewal addendum within 10 days of receipt. Failure to respond will be treated as intent to vacate.",
    whatTheyActuallyWant: "To know if this is legal, and what they have to do in the next ten days so they don't accidentally lose the flat.",
    goodAnswerLooksLike: "Reads the letter back plainly — that's a 19% rise at the end of the lease, not mid-lease, and there's a 10-day clock and a 'silence = you're moving out' clause — then says the legality turns on their state/city notice rules, asks where they are or gives the general rule, and names what to do first.",
    bounceCondition: "Says only 'I'm not a lawyer, consult an attorney'; or confidently asserts a specific notice-period law for the wrong country or state; or misses the 10-day deadline or the intent-to-vacate line, which is the actually dangerous part.",
  },
  {
    id: "summarise-01",
    category: "decode-a-document",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "Priya: ok so for nadias 40th are we doing a group gift\nTom: yes ill sort it like last time\nPriya: legend\nMark: whats the budget\nTom: 25 each? theres 8 of us so 200\nEllie: 25 works\nMark: same\nPriya: what about that spa place in town she keeps going on about\nTom: the one near the church?\nPriya: yeah\nEllie: love that\nTom: half day is 180, i can put the rest towards flowers\nMark: 👍\nEllie: has anyone told steve\nPriya: ill message him\nTom: right ive booked it and paid on my card, can everyone send me 25 by friday, revolut same number as always\nEllie: sent\nMark: sent\nTom: also can someone do the card, im away til thursday\nEllie: ill do the card\nPriya: sorry only just seen this, will send tonight\nTom: oh and nadias sister says the surprise bit is 7 not 8\n\ntldr",
    whatTheyActuallyWant: "To catch up in ten seconds and know if anything is owed by them specifically.",
    goodAnswerLooksLike: "Four or five lines: what was decided, who's doing what, what's still unresolved, and anything the reader needs to do.",
    bounceCondition: "Produces a summary as long as the thread, or a neutral recap that misses the one actionable thing ('send Tom £25 by Friday, and it's 7 not 8'). Also bounces if it asks which parts they care about.",
  },
  {
    id: "explain-01",
    category: "explain-a-concept",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "explain what a deductible is like im 5",
    whatTheyActuallyWant: "To actually understand their insurance before they call the company or pick a plan. The 'like I'm 5' is a request for plain words, not for baby talk.",
    goodAnswerLooksLike: "Two or three short paragraphs with one concrete dollar example ('your deductible is $1,000, the repair is $3,000, you pay the first $1,000'), no jargon and no bullet-point wall.",
    bounceCondition: "Uses 'coinsurance', 'out-of-pocket maximum' and 'copay' in the explanation without defining them, so it explains one unknown word with three more. Or is condescending with fire-truck metaphors instead of just being clear. Or delivers a 900-word tutorial with headers when three paragraphs would do.",
  },
  {
    id: "school-fractions",
    category: "explain-a-concept",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "my daughter has this for homework and i genuinely cant remember how to do it. 3/4 divided by 1/2. shes 10 and has to show her working",
    whatTheyActuallyWant: "To be able to sit next to her and explain it convincingly in about two minutes, and to know what goes on the page.",
    goodAnswerLooksLike: "The keep-flip-multiply steps written out exactly as she'd write them, the answer, and one everyday sentence for why it's bigger than you'd expect ('how many halves fit into three quarters').",
    bounceCondition: "Just gives '1.5' with no working; or explains with algebraic notation and the term 'multiplicative inverse'; or opens with 'Great question! Let's dive in 🎉' and three headed sections before the actual method.",
  },
  {
    id: "factual-01",
    category: "quick-factual-answer",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "how long do you boil eggs for hard boiled",
    whatTheyActuallyWant: "A number. The water is already on the stove.",
    goodAnswerLooksLike: "'About 10-12 minutes once the water's boiling, then straight into cold water.' One or two sentences.",
    bounceCondition: "A 500-word guide with a history of egg cookery, altitude adjustments and a table of six doneness levels before the number appears. They wanted the number in the first line.",
  },
  {
    id: "factual-02",
    category: "quick-factual-answer",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "is costco open on thanksgiving",
    whatTheyActuallyWant: "A yes/no about a specific store on a specific upcoming day.",
    goodAnswerLooksLike: "Says no (they've closed on Thanksgiving for years), notes hours change year to year and around it, and suggests checking their local store page for the exact day.",
    bounceCondition: "States confidently specific hours for a specific date it can't actually know, and the person drives there and it's shut. The other bounce: refusing to say anything at all because 'I don't have real-time information' when the general pattern is a genuinely useful answer.",
  },
  {
    id: "factual-04",
    category: "quick-factual-answer",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "whats the differnce between advil and tylenol",
    whatTheyActuallyWant: "To know which one to take right now for their specific ache, and whether it's safe with what they already took.",
    goodAnswerLooksLike: "One line on the actual difference (ibuprofen is anti-inflammatory, acetaminophen isn't), a sentence on what each is typically better for, and the one real safety note (don't double up on acetaminophen; ibuprofen with food/stomach).",
    bounceCondition: "Refuses on medical grounds and tells them to ask a pharmacist for something printed on the box. Or a comparison table with pharmacokinetics when they wanted 'take the Advil for your back'.",
  },
  {
    id: "decide-01",
    category: "decide-or-advise",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "should i get the toyota rav4 or the honda crv. i have 2 kids and drive like 40 min to work",
    whatTheyActuallyWant: "Someone to have an opinion so they can stop researching. They've read twenty reviews already.",
    goodAnswerLooksLike: "Picks one, gives three concrete reasons tied to their kids and commute, and names the one thing that would flip the recommendation.",
    bounceCondition: "A perfectly balanced pros-and-cons table ending in 'both are excellent choices, it depends on your priorities.' That is exactly the non-answer they came here to escape. Also bounces if it invents trim levels, specs or warranty terms to sound authoritative.",
  },
  {
    id: "money-insurance-jump",
    category: "decide-or-advise",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "my car insurance renewal went from 640 to 918 and literally nothing changed, no claims no points nothing. is that normal? and what do i actually say when i ring them",
    whatTheyActuallyWant: "Reassurance that this is a known thing, and a few sentences they can say on the phone that might actually get the number down.",
    goodAnswerLooksLike: "Yes this is common and why (market-wide increases, loyalty pricing), then the practical bit: get a comparison quote first, and 2-3 plain lines to say on the call, including the one that works ('I've got a quote for X, can you match it').",
    bounceCondition: "Answers only 'prices have gone up, shop around' with no phone script; or gives a stiff formal script full of 'I am writing to formally dispute' that nobody would say out loud; or invents a specific average premium figure for their country.",
  },
  {
    id: "ft-14",
    category: "decide-or-advise",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "is it bad that my check engine light is on but the cars driving fine. its a 2014 honda accord",
    whatTheyActuallyWant: "Whether they can keep driving it this week or need to deal with it now, and roughly what it'll cost.",
    goodAnswerLooksLike: "Clear split: steady light vs flashing light (flashing = stop driving), the cheap common causes first (loose gas cap, O2 sensor), and the free next step — most auto parts stores read the code for nothing.",
    bounceCondition: "'You should take it to a qualified mechanic as soon as possible' with no triage. That's the advice they already had; the whole reason they asked is to find out whether it's a gas cap or a $1,200 problem.",
  },
  {
    id: "money-budget-house",
    category: "numbers-and-formatting",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "we take home about 4300 a month between us. rent 1500, car payment 380, daycare 900, then food and everything else is honestly a mess. we want to buy a house in a couple years and i dont know if thats even realistic",
    whatTheyActuallyWant: "Someone to do the arithmetic they've been avoiding and tell them honestly whether it's possible, plus one place to start.",
    goodAnswerLooksLike: "Does the maths out loud (what's left after the named costs), gives an honest read on whether a deposit in ~2 years is realistic at a plausible savings rate, and names one concrete first step — not five.",
    bounceCondition: "Refuses to work with the numbers until they itemise every expense; or dumps the 50/30/20 rule as a lecture; or moralises about the car payment and daycare; or produces a 30-row spreadsheet-style plan they'll never open again; or gets the arithmetic wrong.",
  },
  {
    id: "excel-sumif",
    category: "numbers-and-formatting",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "in excel ive got a column with amounts and next to it a column that just says paid or unpaid. how do i add up only the paid ones",
    whatTheyActuallyWant: "A formula to paste into a cell right now.",
    goodAnswerLooksLike: "A ready-to-paste SUMIF with plausible column letters, one sentence saying where to type it and which bit to change to match their own columns.",
    bounceCondition: "Explains SUMIF/SUMIFS syntax abstractly with placeholder arguments and never gives a formula they can paste; or suggests a pivot table or a macro; or asks which version of Excel and whether it's a table or a range before helping.",
  },
  {
    id: "sw-13",
    category: "numbers-and-formatting",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "put this into a table so i can actually read it\n\nOffice supplies 342.19, software subscriptions 1,208.00, travel 887.45, client lunches 412.30, phone and internet 265.00, contractor payments 3,400.00, misc 118.72. that was october. november was office 210.00, software 1208, travel 1,540.88, lunches 305.15, phone 265, contractors 2,800, misc 94.40",
    whatTheyActuallyWant: "A clean side-by-side of the two months so they can see what moved — and they probably want totals even though they didn't ask.",
    goodAnswerLooksLike: "A two-column table by category with a totals row and, unprompted, one line pointing out travel nearly doubled. Numbers copied exactly, no invented rows.",
    bounceCondition: "Silently 'fixes' or rounds a number, or invents a category that wasn't there. One wrong number in their own data destroys trust instantly. Also bounces if it refuses to add totals because they weren't requested.",
  },
  {
    id: "food-fridge-dinner",
    category: "plan-or-ideas",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "chicken thighs, half a cabbage, rice, sour cream, usual spices. dinner for 4 in about 40 mins",
    whatTheyActuallyWant: "One recipe they can start cooking in five minutes with only what's listed.",
    goodAnswerLooksLike: "One dish using exactly those things, with rough timings that land inside 40 minutes and the steps in the order you'd actually do them. Assumes salt, oil and an onion; doesn't require a trip to the shop.",
    bounceCondition: "Requires an ingredient they clearly don't have (fresh dill, buttermilk, gochujang); or offers three options with headings when they wanted dinner; or lists options with no actual method so they still have to ask again; or opens with a paragraph about how versatile chicken thighs are.",
  },
  {
    id: "travel-lisbon-kid",
    category: "plan-or-ideas",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "3 days in lisbon in september with a 6 year old, staying near baixa. she gets tired quick so not loads of walking. what should we do",
    whatTheyActuallyWant: "A realistic day-by-day that a small child can survive, with the tram/hill problem accounted for.",
    goodAnswerLooksLike: "Three light days, two or three things per day, grouped so they're not crossing the city twice, with the kid-friendly picks called out and the hills/tram queues acknowledged. Says which day to keep loose.",
    bounceCondition: "Produces a generic 'Top 10 Things To Do In Lisbon' that ignores both the child and the walking limit; or packs six sights into each day; or invents an attraction, price or opening time that doesn't exist.",
  },
  {
    id: "ideas-01",
    category: "plan-or-ideas",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "gift ideas for my dad hes 68 retired, has every tool already, doesnt want stuff. budget 100",
    whatTheyActuallyWant: "A few genuinely usable options that respect 'doesn't want stuff' — they've already thought of the obvious ones.",
    goodAnswerLooksLike: "Six to eight specific ideas skewed toward experiences and consumables, each one line, at the right price point — not a category list like 'consider a hobby-related gift'.",
    bounceCondition: "Suggests a nice toolset or a generic 'personalised mug' after being told he has every tool and doesn't want objects. Shows it didn't read the message. Also bounces on twenty vague options instead of eight good ones.",
  },
  {
    id: "family-text-thread",
    category: "emotional-support",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "am i overreacting here or is she being off with me\n\nme: hey are we still on for sat\nher: cant do sat something came up\nme: no worries is sunday any good\nher: ill let you know\nme: u said that last time lol\nher: wow ok\nme: i didnt mean it like that\nher: its fine",
    whatTheyActuallyWant: "An honest second opinion — mostly reassurance that they're not crazy — and ideally what to send next so it doesn't sit there festering.",
    goodAnswerLooksLike: "Takes a position: reads the exchange, says what probably landed badly on each side, and offers one short message they could actually send in their own voice.",
    bounceCondition: "Refuses to judge because 'I only have one side of the story'; or produces therapy-speak they'd be embarrassed to send ('I feel hurt when my time is deprioritised'); or turns it into a general essay about communication styles in friendships.",
  },
  {
    id: "company-01",
    category: "emotional-support",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "idk if im overreacting. my sister didnt invite me to her thing and everyone else went. we had a fight in may but i thought it was fine",
    whatTheyActuallyWant: "To be heard first, and then honestly told whether their reaction is proportionate. They want a person, not a framework.",
    goodAnswerLooksLike: "Acknowledges the hurt in a sentence without being saccharine, gives an honest read (that sounds deliberate and it makes sense to feel this), and asks one real question or offers one concrete next move — like what they could text her.",
    bounceCondition: "Immediately produces a numbered list of 'strategies for managing family conflict' or suggests therapy in the first reply. Reads as a pamphlet, not a conversation, and they close it. Also bounces if it opens with 'I'm sorry you're going through this' and nothing else.",
  },
  {
    id: "company-02",
    category: "emotional-support",
    roughlyHowCommon: "occasional",
    hasPastedContent: false,
    userInput: "thinking out loud here. i could stay at my job which is fine but boring, or take the offer thats more money but way more hours and my youngest is 3. just typing this to think",
    whatTheyActuallyWant: "A thinking partner. They explicitly said they're not asking for an answer yet — pushing a recommendation too early ends it.",
    goodAnswerLooksLike: "Reflects back the real tension it hears (money vs the years their kid is 3), then asks one or two sharp questions that help them find their own answer. Stays short.",
    bounceCondition: "Immediately recommends taking or refusing the job with a pros-and-cons table, when they said they were thinking out loud. Or floods them with eight questions at once, which feels like an intake form.",
  },
  {
    id: "translate-01",
    category: "translate",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "how do i say \"the appointment is at 3, please bring your insurance card\" in spanish",
    whatTheyActuallyWant: "A sentence they can say or text to a patient/customer right now, that will be understood.",
    goodAnswerLooksLike: "The Spanish sentence, plainly. Maybe a one-line note on formal vs informal 'you' if it matters for the setting.",
    bounceCondition: "A grammar lesson about subjunctive mood and regional variation wrapped around the sentence. Or three regional variants with no recommendation, when they just needed one that works.",
  },
  {
    id: "translate-02",
    category: "translate",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "what does this say\n\nFilha, desculpa não ter ligado antes, o telemóvel do teu tio esteve avariado a semana toda. A avó teve alta na sexta e já está cá em casa connosco, está bem mas ainda muito fraquinha e não pode subir escadas. O médico disse que é preciso paciência. Estamos todos a dar uma ajuda por isso não te preocupes, sim? Diz lá quando é que vens, que a avó pergunta por ti todos os dias. Beijinhos",
    whatTheyActuallyWant: "The meaning, and the emotional register — is this bad news, is this an invitation, is she upset.",
    goodAnswerLooksLike: "A natural English translation, plus one line if the tone is notable ('this reads as warm and reassuring, but she is asking you to visit').",
    bounceCondition: "A stiff word-for-word translation that loses the meaning, or announcing which language it is and asking whether they'd like it translated.",
  },
  {
    id: "ft-01",
    category: "session-mechanics",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "what can you do",
    whatTheyActuallyWant: "A reason to type a second message — they genuinely don't know what this is for and are hoping something on the list sounds useful to their actual life.",
    goodAnswerLooksLike: "Four or five concrete, ordinary examples in the shape of things a person would actually type ('rewrite an email so it sounds nicer', 'explain a letter from the bank'), and an invitation to just paste something.",
    bounceCondition: "A capability inventory of abstract categories — 'writing assistance, analysis, brainstorming, coding, research' — which tells them nothing about whether it can help with the thing on their desk. They close the tab because nothing on the list was recognisable.",
  },
  {
    id: "ft-04",
    category: "session-mechanics",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "is this thing private. can other people see what i type here",
    whatTheyActuallyWant: "To know whether it's safe to paste something personal — a medical letter, a message from their ex, their finances — before they do it.",
    goodAnswerLooksLike: "A direct, specific, non-marketing answer about where their words actually go and who could see them, including the honest caveats. Short enough to read in ten seconds.",
    bounceCondition: "Vague reassurance ('your privacy is important to us') or an overclaim that a savvy user would doubt. Equally bad: three paragraphs of hedged policy language. They'll conclude the answer is being dodged and won't paste the thing they came to paste.",
  },
  {
    id: "ft-08",
    category: "session-mechanics",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "that didnt really answer my question",
    whatTheyActuallyWant: "A second attempt that's actually different — they will not explain what was wrong, and this is their last try before leaving.",
    goodAnswerLooksLike: "Takes a genuinely different angle (shorter, more concrete, more direct), one brief acknowledgement at most, no defensiveness. If it truly can't tell what missed, one sharp question — not three.",
    bounceCondition: "'I apologize for the confusion. Could you clarify what specifically you were looking for?' followed by a reworded version of the same answer. The apology-plus-repeat is the classic bounce; they have now spent two turns and gotten nothing.",
  },
  {
    id: "ft-13",
    category: "session-mechanics",
    roughlyHowCommon: "common",
    hasPastedContent: false,
    userInput: "ok but can you just tell me what to do",
    whatTheyActuallyWant: "A decision. The previous answer laid out options or tradeoffs and they don't have the expertise or energy to choose.",
    goodAnswerLooksLike: "Picks one, says it in the first line, gives the one-sentence reason, and states what would change the recommendation. No re-listing the alternatives.",
    bounceCondition: "'It really depends on your priorities and situation.' They just explicitly asked it to stop doing that. Refusing to commit twice in a row is the point they conclude it's designed to avoid being useful.",
  },
  {
    id: "sw-12",
    category: "session-mechanics",
    roughlyHowCommon: "very-common",
    hasPastedContent: false,
    userInput: "no i meant the second one",
    whatTheyActuallyWant: "For the assistant to work out which of its own previous items was second and just act on it — expand it, use it, rewrite in that direction. No re-explaining.",
    goodAnswerLooksLike: "Silently picks the right item, restates it in four words so they know it's tracking, and delivers.",
    bounceCondition: "Asks 'could you clarify which option you mean?' when there were numbered items right there in the previous message, or re-lists all the options again. This is the single clearest signal that the thing has no memory, and it ends the session.",
  },
  {
    id: "ft-15",
    category: "session-mechanics",
    roughlyHowCommon: "occasional",
    hasPastedContent: false,
    userInput: "sorry i pasted the wrong thing ignore that",
    whatTheyActuallyWant: "For it to drop the previous paste and wait, with zero fuss — and quiet reassurance that the mistake didn't cause a problem.",
    goodAnswerLooksLike: "One short line: no problem, ignored, send the right one. Nothing more.",
    bounceCondition: "Summarizes or comments on the wrong paste anyway ('I understand — the document about your divorce settlement has been disregarded'), which is mortifying if it contained something private. Or a paragraph of reassurance about the mistake.",
  },
  /**
   * ── WAVE 2 — the proofread-class jobs, appended 2026-07-31 ─────────────────
   *
   * Nine items from a second authoring pass, added because the first forty left
   * one job class almost unrepresented and one measurement stranded on it. The
   * probe module's `EVERYDAY_WORDING_PRESERVATION_ITEM_IDS` — the only place
   * `preservesUserText` reads the right way round — held exactly ONE item, and
   * said so: "Widening it means adding proofread-class jobs to the corpus, not
   * relaxing the criterion." This is that widening.
   *
   * ★ THEY ARE ALL THE SAME JOB AND DELIBERATELY DIFFERENT PEOPLE. Every one is
   * "fix my mistakes but do not make it stop sounding like me" — the variation is
   * WHOSE voice is at risk: an adult learning English, a sixteen-year-old, a
   * tradesman, a widower, an anxious applicant, a shift supervisor, a marketplace
   * seller, a shop owner, a dyslexic parent. A voice-preservation gate that only
   * ever sees one register is not measuring register.
   *
   * ★ WHAT IS THE INTEGRATOR'S AND NOT THE AUTHORS'. `userInput` and
   * `bounceCondition` are the authoring pass's, verbatim — the record. The
   * authoring pass was not asked for `whatTheyActuallyWant`, `goodAnswerLooksLike`
   * or `roughlyHowCommon`, so those three are read off the persona and the bounce
   * by whoever integrated them, and are the weakest thing here. Argue with them
   * from the item's own text, the same as any Layer 2 entry. Nothing in the
   * codebase derives from `roughlyHowCommon`.
   *
   * ONE EDIT was made to the record: two empty junk keys the authoring pass left
   * on the school-post item ("bounke_condition", "turns_note") were dropped. No
   * bounce text was changed.
   *
   * A tenth item — a school-bus driver's cover letter — was authored, reviewed and
   * DROPPED at integration rather than included. Its job and its bounce duplicated
   * the vet-clinic application below, whose bounce names the sharper failure (the
   * reply correcting the person rather than the text), and its letter mixed a
   * British spelling into otherwise North American details, which would leave a
   * legitimate spelling correction looking like a voice violation. A corpus is a
   * record of jobs people bring; two copies of one job is still one job.
   */
  {
    id: "proofread-teacher-note-esl",
    category: "rewrite-my-text",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "hi can you check this for mistakes please. is for my son teacher, i wrote it my self, english is not my first language so probably is many errors. but dont change the way i say things ok, only correct what is wrong:\n\nDear Ms. Halbrook,\n\nI am the mother of Mateo of your class of 4 grade. I want to say sorry because he not finish the reading log since two weeks. In this moment we are living in the house of my sister because we lose our apartment, and in the nights is very difficult, there is many people in one room and he cannot concentrate for read. He is not a lazy boy. He like very much your class, specially the part of the volcanos, he explain to me all the thing about the lava in the dinner. If is possible to give him more days for the project of the poster i promise you he will do it good.\n\nSorry for the inconvenient, and sorry for my english.\n\nWith respect,\nYaneth",
    whatTheyActuallyWant: "The mistakes gone so the teacher reads her as a competent adult — but it is still her note, including the apology at the end, which she meant to write.",
    goodAnswerLooksLike: "The corrected note and nothing else: 'he not finish' becomes 'he has not finished', 'since two weeks' becomes 'for two weeks', 'is many people' becomes 'there are many people'. The lava-at-dinner line, the closing apology and the order of her own sentences all survive.",
    bounceCondition: "The reply comes back as smooth institutional English that is no longer hers — \"Dear Ms. Halbrook, I hope this message finds you well. I am writing regarding my son Mateo's incomplete reading log. Due to a temporary change in our housing situation, he has had limited opportunity to study at home. Mateo is highly engaged in your class, particularly the volcano unit.\" — with \"Sorry for the inconvenient, and sorry for my english\" deleted, the dinner/lava detail cut as unnecessary, and a closing note like \"I also smoothed out a few non-native constructions so it reads more naturally to an American teacher.\" She sees her own voice replaced by a stranger's and never pastes anything personal into it again.",
  },
  {
    id: "proofread-birthday-caption",
    category: "rewrite-my-text",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "can u fix the spelling and stuff in this, i typed it too fast. its a bday post for my best friend. dont make it sound like somebodys mom wrote it tho i still need it to sound like me\n\nhappy 17th to the loudest human ive ever met 😭😭 idk what i did to deserve u fr\n\nu sat with me on the floor of the 2nd floor bathroom for like an entire hour freshman year when i was crying abt something so so stupid and u have never once brought it up again, not even as a joke, and i think abt that alot more then u know. ur the only person who answers me at 2am and the only person whos alowed to call me annoying bc u earned it\n\nthank u for driving me to work when my car died in janurary and for eating half my fries every time even tho u \"wernt hungry\" (ur not slick)\n\ni hope u get that stupid ugly car ur obsessed with. i hope this year is so good to u. love u alot idc. dont get weird abt this",
    whatTheyActuallyWant: "The actual misspellings fixed so the post does not look careless, with the shorthand, the emoji and the line breaks untouched — the whole point is that it reads like she typed it.",
    goodAnswerLooksLike: "The corrected caption and nothing else: 'alot', 'then u know', 'whos alowed', 'janurary' and 'wernt' fixed, and nothing else touched — u stays u, ur stays ur, abt stays abt, the emoji stay, the line breaks stay where she put them.",
    bounceCondition: "It hands back a tidy paragraph in Standard English — \"Happy 17th birthday to the loudest human I have ever met! I don't know what I did to deserve you.\" — with every u expanded to you, ur to your, abt to about, the emoji stripped, the line breaks collapsed into one block, and \"don't get weird about this\" given a period and a capital D. She reads two lines, thinks it sounds like a birthday card from an aunt, and closes it.",
  },
  {
    id: "proofread-memorial-tribute",
    category: "rewrite-my-text",
    roughlyHowCommon: "occasional",
    hasPastedContent: true,
    userInput: "need a hand with this one. im a sparky not a writer. its going in the memorial book for my old boss who passed last week. just knock the spelling errors out of it please, dont go turning my words into something posh, the family will know it isnt me\n\nI started with Ray in 1998 when i was 19 and didnt know a screwdriver from my elbow. He seen straight away i was greener than grass and he never once made me feel small about it. He'd tell you when you stuffed up, loud, in front of the whole crew, and then he'd buy you a pie at smoko like nothing had happend. That was Ray, all of it out in the open, nothing saved up for later.\n\nHe worked in the rain and he worked in the heat and he done jobs for pensioners for nothing and told them the parts was free, which they wernt. Alot of blokes in this trade wouldnt have a licence today if he hadnt given them a start when nobody else would.\n\nI owe him my trade and my house and probly my marraige to. Rest easy boss.",
    whatTheyActuallyWant: "The spelling errors gone before it goes in a book his old boss's family will read, without the piece stopping sounding like him.",
    goodAnswerLooksLike: "The corrected text and nothing else: 'happend', 'wernt', 'Alot', 'probly', 'marraige' and 'to' for 'too' fixed, while smoko, blokes, greener than grass, 'he done jobs for pensioners' and 'Rest easy boss' all stay exactly as written.",
    bounceCondition: "It returns a smoothed eulogy in funeral-program English — \"Ray immediately recognised my inexperience, yet never made me feel inadequate. He offered candid feedback, then extended a gesture of goodwill during the break\" — with smoko, stuffed up, blokes, greener than grass and \"Rest easy boss\" all gone, and \"I owe him my trade and my house and probly my marraige to\" turned into \"I am indebted to him both professionally and personally.\" He can hear that it isn't him, decides the thing can't be trusted with anything that matters, and shuts it.",
  },
  {
    id: "proofread-grandfather-letter",
    category: "rewrite-my-text",
    roughlyHowCommon: "occasional",
    hasPastedContent: true,
    userInput: "Hello.  I am not very good on the computer.  Could you please fix my spelling in this letter to my granddaughter.  Please leave it in my own words, I do not want it sounding like one of those form letters.\n\nMy Dear Sunny,\n\nWell.  Here we are.  I still see you at four years old in the pool with the orange floaties on your arms, and now your driving 600 miles away to a college I have to look up on a map.\n\nYour Grandmother would of been so proud of you.  She would of told the entire grocery store, twice, and then told the pharmacy.\n\nI put a little something in the envelope.  Dont argue with me about it and dont spend it all on coffee.  If your roomate turns out to be a slob just remember you was not always a angel yourself, ask your mother.\n\nCall on Sundays if you can.  If you forget I wont be sore about it, you have a life now and thats how it should be.\n\nI am very proud of you honey.  You did this your self.\n\nLove always,\nPapa",
    whatTheyActuallyWant: "His spelling fixed and nothing else moved, so the letter that goes in the envelope is still the one he wrote.",
    goodAnswerLooksLike: "The corrected letter and nothing else: 'would of' becomes 'would have', 'your driving' becomes 'you're driving', 'roomate' becomes 'roommate', 'you was' becomes 'you were', 'a angel' becomes 'an angel', 'your self' becomes 'yourself'. 'Well.  Here we are.' stays punctuated exactly as he punctuated it, the double spaces stay, the grocery store and pharmacy joke stays.",
    bounceCondition: "It comes back reflowed and warmed over into a greeting-card voice — \"My dearest Sunny, As you embark on this exciting new chapter of your life...\" — the double spaces normalised, the \"Well.  Here we are.\" opening merged into a longer sentence, the grocery store/pharmacy joke trimmed for concision, and \"You did this your self\" polished to \"You should be proud of everything you have accomplished.\" He recognises none of it, doesn't know how to get his own version back, and gives up on the whole thing.",
  },
  {
    id: "proofread-vet-application",
    category: "rewrite-my-text",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "theres a box on this job application that says tell us about yourself and i wrote this at like 1am. can you fix the typos and grammar. please dont make me sound like some confident sales guy, im not that person, i just dont want to look sloppy\n\nHi, my name is Devi and im applying for the vet assistant position. I dont have the certificate you listed and im going to be honest about that up front. What i do have is 3 years volunteering at the shelter on Marsh Rd, most saturdays and alot of weeknights, and in that time ive restrained plenty of scared dogs, cleaned the kennels nobody else wanted to clean, and sat with animals that were being put down so they wernt by themself.\n\nI am relaible. I have never called out except the week my mom was in the hospital and i made that shift up.\n\nI know i probably look under qualified on paper and i understand if thats a problem for you. I just wanted the chance to say that i work hard and i learn fast if somebody shows me once.\n\nThank you for reading all this, i know your busy.\nDevi",
    whatTheyActuallyWant: "The typos gone so she does not look sloppy, with the two admissions she decided to make — no certificate, under-qualified on paper — still in it.",
    goodAnswerLooksLike: "The corrected text and nothing else: 'im' becomes 'I'm', 'wernt' becomes 'weren't', 'themself' becomes 'themselves', 'relaible' becomes 'reliable', 'alot' becomes 'a lot', 'your busy' becomes 'you're busy'. The certificate admission, the under-qualified line and the thank-you at the end all stay.",
    bounceCondition: "It returns a confident applicant-tracking-system version she would never say out loud — \"I am a highly motivated and reliable animal care professional with 3+ years of hands-on experience in a high-volume shelter environment, eager to bring my compassion and work ethic to your team\" — with the certificate admission and \"I know i probably look under qualified\" deleted, plus a line at the end like \"Note: I removed the apologetic language, as it undermines your candidacy.\" She feels corrected as a person rather than proofread, and closes the tab.",
  },
  {
    id: "proofread-crew-email",
    category: "rewrite-my-text",
    roughlyHowCommon: "very-common",
    hasPastedContent: true,
    userInput: "can someone proofread this before i send it to my crew, just typos and grammar. dont turn it into HR speak, they can smell that from the parking lot\n\nHey all,\n\nStarting monday were switching over to the new scanners on the pick line. I know. I know. The old ones get collected wednesday so dont hide one in your locker like last time, you know who you are.\n\nCouple of things. You have to badge in every shift now, it doesnt remember you anymore. Two beeps means a bad scan, scan it again, dont just chuck it in the tote and hope for the best. Your going to be slower for about a week and thats completely fine, nobody is getting wrote up over numbers while we adjust. If it effects your break timing come tell me and well move it.\n\nMarisol has cheat sheets printed if you want one at the desk.\n\nAsk me if anything is weird. Id rather answer 40 questions on monday than fix 40 mistakes on tuesday.\n\nThanks,\nDez",
    whatTheyActuallyWant: "A fast typo pass so she can hit send — the crew has to read it and hear her, not management.",
    goodAnswerLooksLike: "The corrected email and nothing else: 'were switching' becomes 'we're switching', 'Your going to be' becomes 'You're going to be', 'getting wrote up' becomes 'getting written up', 'If it effects' becomes 'If it affects'. 'I know. I know.', 'you know who you are' and the forty-questions line stay untouched.",
    bounceCondition: "It sends back a policy memo — \"Please be advised that effective Monday, the pick line will transition to updated scanning hardware. Employees are required to authenticate with their badge at the start of each shift. A temporary reduction in throughput is anticipated during the adjustment period.\" — with \"you know who you are\", the two-beeps warning in her own words, and the 40 questions line all removed. She'd have to retype the whole thing from memory to sound like herself again, so she stops using it for anything she actually sends.",
  },
  {
    id: "proofread-marketplace-ad",
    category: "rewrite-my-text",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "reposting my marketplace ad, can you just clean up the spelling in it. keep it short and keep the tone the way it is, i dont want it reading like a car dealership wrote it\n\nSolid oak dining table + 4 chairs. $180 obo.\n\nCame from my grandparents. Its heavy as anything, takes two people, dont show up alone and expect me to help you carry it down the steps. Theres a water ring on one side and a few scratchs. Its not perfect, its 40 years old, but its real wood not that particle board junk that sags in two years.\n\nCusions on the chairs are seperate and come off to wash. Smoke free pet free home. One chair has a wobble, its the back left one, i tightened it and it holds but im telling you anyway.\n\nPick up only, north end, i dont deliver and i dont ship, please dont ask. First come first serve, if your not here by the time you told me im moving on to the next person. Cash or etransfer.\n\nNo lowballers. I know what i have.",
    whatTheyActuallyWant: "The half-dozen spelling mistakes fixed before he reposts, with the blunt lines that filter out time-wasters left exactly where they are.",
    goodAnswerLooksLike: "The corrected ad and nothing else: 'scratchs' becomes 'scratches', 'Cusions' becomes 'Cushions', 'seperate' becomes 'separate', 'your not here' becomes 'you're not here'. Same short lines, same order, and 'No lowballers. I know what i have.' still the last line.",
    bounceCondition: "It hands back sales copy — \"Beautiful vintage solid oak dining set — a timeless heirloom piece! Gently worn with charming character marks that tell a story. Comfortable removable cushions for easy cleaning. Priced to sell!\" — restructured into bullet points with emoji, the wobbly-chair disclosure buried or dropped, and \"No lowballers. I know what i have.\" removed as \"unwelcoming to buyers.\" He wanted six typos fixed and got an ad that would attract exactly the people he's trying to filter out.",
  },
  {
    id: "proofread-review-reply",
    category: "rewrite-my-text",
    roughlyHowCommon: "occasional",
    hasPastedContent: true,
    userInput: "someone left this review on my shop and i wrote a reply. can you check my spelling and grammer before i post it but leave it how i said it, im not going to grovel\n\nthe review:\n★★☆☆☆  3 days ago\n\"Ordered a cake for my daughters birthday, it was supposed to be lavender and it came out more grey. Staff was nice enough. Wont be back.\"\n\nmy reply:\nHi Trina, thank you for taking the time. Your right that the colour came out greyer then the swatch and im sorry, that one is on us.\n\nWhat happened is we use a natural colouring instead of the gel kind, because a few of our regular familys have dye sensitivitys and we made the call years ago to go without. The natural violet turns dull when it hits the fat in the buttercream. I should of told you that when you ordered so you could of picked a different colour, and i didnt. Thats my miss, not yours.\n\nIf youd called us that week i would of remade it or refunded the colouring. That offer still stands whenever you want it, no expiry, just ask for me by name.\n\nEither way i hope your daughter had a good birthday.\n— Bekah, owner",
    whatTheyActuallyWant: "Her spelling checked before it goes public under her own name — the reply she wrote, including the reason she gave, is the thing she wants posted.",
    goodAnswerLooksLike: "Her corrected reply and nothing else: 'Your right' becomes 'You're right', 'greyer then' becomes 'greyer than', 'familys' becomes 'families', 'sensitivitys' becomes 'sensitivities', and 'should of', 'would of' and 'could of' all become 'have'. The dye-sensitivity explanation and 'Thats my miss, not yours' stay in.",
    bounceCondition: "It replaces her reply with the generic template every chain uses — \"Dear Trina, We sincerely apologise that your recent experience did not meet expectations. Your feedback is important to us and we have shared it with our team. We hope to have the opportunity to serve you again.\" — the dye-sensitivity explanation cut as \"defensive\", \"Thats my miss, not yours\" gone, and maybe a note advising her not to explain herself publicly. The one thing she actually wanted to say is the thing it deleted, so she posts her unproofread original and never comes back.",
  },
  {
    id: "proofread-school-post",
    category: "rewrite-my-text",
    roughlyHowCommon: "common",
    hasPastedContent: true,
    userInput: "posting this on the school parents page tonight, can you fix my typos, im dyslexic and i miss stuff. dont rewrite the whole thing though, last time somebody helped me they turned it into a newsletter and literally 2 people read it\n\nHI EVERYONE 👋 quick one about the crossing at Delmar & 5th.\n\n3 near misses this month that i know of. one of them was my kid, on the 14th, driver didnt even slow down. The city says they will look at it in the fall budget review which is not good enough for me and i dont think it should be good enough for you either.\n\nSo we are just doing it ourselfs. Walking group. Meet at the corner by the laundromat at 7:40am, i will be there in a orange vest looking absolutley ridiculous, and we take the kids across together untill they put a proper light in.\n\nI need 2 more adults for fridays. Thats the whole ask. You dont have to come every day, one day is fine, its ten minutes of you life and you were walking anyway.\n\nAlso if you seen a near miss there please email the councillor, theres a form, ill drop the link in the comments. It counts alot more when its 30 of us and not just me being the annoying lady again.",
    whatTheyActuallyWant: "The typos she cannot catch herself caught, and the post handed back ready to paste — she is dyslexic, so a list of corrections to apply is precisely the task she came here to avoid.",
    goodAnswerLooksLike: "The corrected post and nothing else: 'ourselfs' becomes 'ourselves', 'a orange' becomes 'an orange', 'absolutley' becomes 'absolutely', 'untill' becomes 'until', 'if you seen' becomes 'if you saw', 'you life' becomes 'your life', 'alot' becomes 'a lot'. The emoji, the orange vest, 'the annoying lady again' and her line breaks all stay.",
    bounceCondition: "It gives her a numbered audit instead of a fixed post — \"1. 'ourselfs' → 'ourselves' (irregular plural). 2. 'a orange' → 'an orange' (the article 'an' precedes vowel sounds). 3. 'untill' → 'until'...\" — eleven items with rule explanations and no corrected text, so the dyslexic person now has to hand-apply eleven edits at 11pm and re-check her own work, which is precisely the task she couldn't do. Equally fatal: returning it as \"Dear Parents and Guardians, We wish to bring to your attention a pedestrian safety concern at the intersection of Delmar and 5th\" with the emoji, the orange vest and \"the annoying lady again\" removed.",
  },
];

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 2 — our derivation. Arguable, and meant to be argued with: change an
 * entry here by making the case from the item's own text, quoted in `why`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const ROUTING_NEEDS: Readonly<Record<string, RoutingNeedEntry>> = {
  "work-email-tone-fix": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"Returns a bulleted 'analysis of the tone problems' before (or instead of) the rewrite … or triples the length into corporate boilerplate.\" The deliverable is the email itself, rebuilt from her sentences.",
  },
  "work-followup-shorter": {
    priorTurns: true,
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "Bounce: \"replies 'Sure! Here's a shorter version:' and then produces something the same length\" and \"Rewrites it from scratch so it no longer sounds like the version they liked.\" Shorter is the entire request.",
  },
  "rewrite-03": {
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "Bounce: \"A balanced essay on how tone is subjective … without ever answering.\" Wants a verdict in the first line, then their own sentence softened.",
  },
  "sw-15": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"Rewrites it into neutral business prose … which is precisely the thing they said not to do. Also bad: a list of every correction made instead of the clean text.\" Keeping their words IS the task.",
  },
  "school-essay-not-ai": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"quietly changes their argument to a more sophisticated one they can't explain in class.\" Their sentences and their argument must survive the edit.",
  },
  "work-sick-text": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "The user typed \"keep it short and dont make it weird\". Bounce: \"a formal email with a subject line … or three labelled options with headings.\"",
  },
  "draft-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"Asks four follow-up questions … before writing anything. Or writes something so hedged and flowery it doesn't actually say the kid is struggling.\" The deliverable is one ready-to-send message.",
  },
  "admin-gym-cancellation": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Good answer: \"A short, firm, unemotional letter\" that requests \"confirmation of cancellation and refund of those payments\". The deliverable is the letter itself; developing reasons and implications around it is the failure.",
  },
  "family-eulogy": {
    needs: ["no-elaboration-hint", "needs-guidance"],
    why: "Bounce: \"Opens with a list of clarifying questions before writing a word … or adds cheerful formatting and headings.\" The good answer is \"A warm 2-3 minute draft in plain, spoken language\" weaving five supplied facts — structurally multi-part with no brevity bound, so it must still receive guidance rather than the barest treatment.",
  },
  "ft-06": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"Demands details before writing anything … when they wanted to see it just do the thing.\" A short poem is the whole deliverable.",
  },
  "health-blood-results": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"produces a paragraph of biochemistry on every single marker including the normal ones.\" Wants the two off numbers named, not a tour of the panel.",
  },
  "health-hospital-letter": {
    needs: ["no-elaboration-hint", "needs-guidance", "faithful-reproduction"],
    why: "Bounce: \"leads with 'I'm not a doctor' for two paragraphs before saying anything useful\" … and \"invents a detail the letter doesn't contain\". The answer has to carry \"6mm\" and \"3 months\" back out unaltered. The good answer is \"Plain-English line by line\" plus an honest read on how worried to be — multi-part with no brevity bound, so it must still receive guidance.",
  },
  "school-letter-esl-parent": {
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "Good answer: \"Three simple lines.\" Bounce: \"leaves out the 8 August deadline or the £45\" — the whole value of the reply is two figures lifted verbatim from a letter the reader could not parse.",
  },
  "legal-rent-increase": {
    needs: ["no-elaboration-hint", "needs-guidance", "faithful-reproduction"],
    why: "Bounce: \"misses the 10-day deadline or the intent-to-vacate line, which is the actually dangerous part.\" The dollar figures and the 10-day clock must come back out intact. The good answer reads the letter back, rules on legality, and \"names what to do first\" — multi-part with no brevity bound, so it must still receive guidance.",
  },
  "summarise-01": {
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "The user typed \"tldr\". Bounce: \"Produces a summary as long as the thread\" and \"misses the one actionable thing ('send Tom £25 by Friday, and it's 7 not 8')\" — that one line is three specifics quoted straight from the transcript.",
  },
  "explain-01": {
    needs: ["direct-budget"],
    why: "The one item that genuinely wants explaining, so it carries NO no-elaboration-hint. But it is still bounded: \"Two or three short paragraphs with one concrete dollar example\", against a bounce of \"delivers a 900-word tutorial with headers when three paragraphs would do\". Being told to explain and being given room to sprawl are different things.",
  },
  "school-fractions": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"opens with 'Great question! Let's dive in 🎉' and three headed sections before the actual method.\" The deliverable is the working, as the child would write it.",
  },
  "factual-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "What they want: \"A number. The water is already on the stove.\" Bounce: \"A 500-word guide with a history of egg cookery … before the number appears.\"",
  },
  "factual-02": {
    needs: ["no-elaboration-hint"],
    why: "Wants \"A yes/no about a specific store on a specific upcoming day.\" Bounce is over-confidence or blanket refusal — either way the deliverable is a verdict, not a discussion.",
  },
  "factual-04": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"a comparison table with pharmacokinetics when they wanted 'take the Advil for your back'.\"",
  },
  "decide-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"A perfectly balanced pros-and-cons table ending in 'both are excellent choices, it depends on your priorities.' That is exactly the non-answer they came here to escape.\" A hint asking for tradeoffs writes the bounce.",
  },
  "money-insurance-jump": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"Answers only 'prices have gone up, shop around' with no phone script.\" The deliverable is 2-3 lines they can say on the call.",
  },
  "ft-14": {
    needs: ["no-elaboration-hint"],
    why: "Bounce: \"'You should take it to a qualified mechanic as soon as possible' with no triage.\" Wants a verdict on whether to keep driving this week.",
  },
  "money-budget-house": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"dumps the 50/30/20 rule as a lecture … or produces a 30-row spreadsheet-style plan they'll never open again.\" The good answer \"names one concrete first step — not five\", which is an explicit quantity bound.",
  },
  "excel-sumif": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"Explains SUMIF/SUMIFS syntax abstractly with placeholder arguments and never gives a formula they can paste.\" Good answer is a formula plus \"one sentence\".",
  },
  "sw-13": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"Silently 'fixes' or rounds a number … One wrong number in their own data destroys trust instantly.\" The reply must reproduce fourteen figures from the user's own turn exactly — the documented corruption class (\"332,026\").",
  },
  "food-fridge-dinner": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"offers three options with headings when they wanted dinner … or opens with a paragraph about how versatile chicken thighs are.\" The deliverable is one method.",
  },
  "travel-lisbon-kid": {
    needs: ["needs-guidance"],
    why: "The good answer is \"Three light days, two or three things per day\" with \"the kid-friendly picks called out and the hills/tram queues acknowledged\" — structurally multi-part with no brevity bound, so it must still receive guidance rather than the barest treatment.",
  },
  "ideas-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"twenty vague options instead of eight good ones\" and \"a category list like 'consider a hobby-related gift'.\" Wants specific one-line items, not developed reasoning.",
  },
  "family-text-thread": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"turns it into a general essay about communication styles in friendships.\" Wants a position plus one short message they could send.",
  },
  "company-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"Immediately produces a numbered list of 'strategies for managing family conflict' … Reads as a pamphlet, not a conversation, and they close it.\"",
  },
  "company-02": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Good answer \"Stays short\". Bounce: \"floods them with eight questions at once, which feels like an intake form\" — and they explicitly said they are thinking out loud, not asking.",
  },
  "translate-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"A grammar lesson about subjunctive mood and regional variation wrapped around the sentence.\" The deliverable is one Spanish sentence.",
  },
  "translate-02": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Good answer: \"A natural English translation, plus one line if the tone is notable.\" Bounce: \"announcing which language it is and asking whether they'd like it translated.\"",
  },
  "ft-01": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"A capability inventory of abstract categories … They close the tab because nothing on the list was recognisable.\" Wants four or five concrete examples.",
  },
  "ft-04": {
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Good answer: \"Short enough to read in ten seconds.\" Bounce: \"three paragraphs of hedged policy language.\"",
  },
  "ft-08": {
    priorTurns: true,
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"The apology-plus-repeat is the classic bounce.\" Good answer takes \"a genuinely different angle (shorter, more concrete, more direct)\".",
  },
  "ft-13": {
    priorTurns: true,
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "The user literally asked it to stop surveying: \"ok but can you just tell me what to do\". Bounce: \"'It really depends on your priorities and situation.'\" Good answer: \"No re-listing the alternatives.\"",
  },
  "sw-12": {
    priorTurns: true,
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Good answer: \"Silently picks the right item, restates it in four words so they know it's tracking, and delivers.\" Bounce: \"re-lists all the options again.\"",
  },
  "ft-15": {
    priorTurns: true,
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Good answer: \"One short line: no problem, ignored, send the right one. Nothing more.\" Bounce: \"a paragraph of reassurance about the mistake.\"",
  },
  // ── WAVE 2 — the proofread-class jobs ─────────────────────────────────────
  // All nine carry the same three needs, and for the same reason each time: the
  // deliverable IS the user's own text with the fixes in it, so a hint to develop
  // writes the bounce, a budget above the direct band invites the rewrite they
  // said not to do, and a prompt-inclusive n-gram ban makes the job impossible.
  // None carries `needs-guidance`: every one of them names a bound.
  "proofread-teacher-note-esl": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"the dinner/lava detail cut as unnecessary\", and a closing note explaining that a few non-native constructions were smoothed out. The deliverable is her own note with the errors taken out of it, and nothing else moved.",
  },
  "proofread-birthday-caption": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"with every u expanded to you, ur to your, abt to about, the emoji stripped, the line breaks collapsed into one block\". Her exact characters are the deliverable; the fixes are five words inside them.",
  },
  "proofread-memorial-tribute": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"with smoko, stuffed up, blokes, greener than grass and 'Rest easy boss' all gone\". He typed \"dont go turning my words into something posh, the family will know it isnt me\" — his words coming back is the whole job.",
  },
  "proofread-grandfather-letter": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"the 'Well.  Here we are.' opening merged into a longer sentence, the grocery store/pharmacy joke trimmed for concision, and 'You did this your self' polished\". He asked for spelling only: \"Please leave it in my own words\".",
  },
  "proofread-vet-application": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"with the certificate admission and 'I know i probably look under qualified' deleted, plus a line at the end like 'Note: I removed the apologetic language, as it undermines your candidacy.'\" She typed \"please dont make me sound like some confident sales guy\".",
  },
  "proofread-crew-email": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"the two-beeps warning in her own words, and the 40 questions line all removed. She'd have to retype the whole thing from memory to sound like herself again\". The deliverable is her email with four homophones fixed.",
  },
  "proofread-marketplace-ad": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "The user typed \"keep it short and keep the tone the way it is\". Bounce: \"restructured into bullet points with emoji, the wobbly-chair disclosure buried or dropped, and 'No lowballers. I know what i have.' removed as 'unwelcoming to buyers.'\"",
  },
  "proofread-review-reply": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"the dye-sensitivity explanation cut as 'defensive', 'Thats my miss, not yours' gone\" — and \"The one thing she actually wanted to say is the thing it deleted\". She typed \"leave it how i said it, im not going to grovel\".",
  },
  "proofread-school-post": {
    needs: ["no-elaboration-hint", "faithful-reproduction", "direct-budget"],
    why: "Bounce: \"eleven items with rule explanations and no corrected text, so the dyslexic person now has to hand-apply eleven edits at 11pm\" — and the alternative failure strips \"the emoji, the orange vest and 'the annoying lady again'\". Only her own post, corrected, is an answer.",
  },
};

/** Items carrying a given routing need. */
export function itemsNeeding(need: RoutingNeed): readonly EverydayUseItem[] {
  return EVERYDAY_USE_CORPUS.filter((item) =>
    ROUTING_NEEDS[item.id]?.needs.includes(need) ?? false,
  );
}

/** The derived needs for one item, or an empty entry if it has none. */
export function needsFor(id: string): RoutingNeedEntry {
  return ROUTING_NEEDS[id] ?? { needs: [], why: "" };
}

/** Whether this item's turn follows an earlier exchange. */
export function hasPriorTurns(id: string): boolean {
  return ROUTING_NEEDS[id]?.priorTurns === true;
}
