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
