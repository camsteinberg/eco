// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The everyday-use corpus, in conversations — the same record of what ordinary
 * people bring, for the jobs that only exist across more than one turn.
 *
 * WHY THIS EXISTS. Its sibling `everyday-use-corpus.ts` is forty-nine single
 * turns, and it says so about itself: everything in it is turn-shaped. Five of
 * its items are anaphoric ("no i meant the second one", "shorter.") and even
 * those are measured as opening turns, because the exchange they answer is not in
 * the file and inventing one would be authoring corpus content. That leaves an
 * entire class of ordinary failure unreachable from that shape:
 *
 *   - a correction that lands two turns after the thing it corrects,
 *   - a job assembled from constraints that arrive one at a time,
 *   - a topic dropped and picked back up after something else,
 *   - a document pasted early and referred back to long afterwards.
 *
 * None of that is exotic. It is how people actually use an assistant for anything
 * that takes more than one message, and nothing measured before this file existed
 * could see any of it.
 *
 * ★ THE BOUNCE CONDITION IS STILL THE ACCEPTANCE CRITERION, and it is what makes
 * a conversation a corpus item rather than a transcript. Each item is one
 * conversation built to reach ONE ask, and the bounce names the response to that
 * ask that would make this person give up.
 *
 * TWO LAYERS, DELIBERATELY SEPARATE — the same split, for the same reason.
 *
 *   1. `EVERYDAY_CONVERSATION_CORPUS` — the authored record, verbatim. A
 *      statement about people; it does not change because our code changed.
 *   2. `CONVERSATION_ROUTING_NEEDS` — our derivation: which turn is under test,
 *      and the routing properties that turn's bounce condition implies. Every
 *      entry quotes the corpus text it rests on and can be argued with.
 *
 * ★ THE ASSISTANT TURNS ARE NOT A CLAIM ABOUT OUR MODEL. They exist so the user
 * turns make sense in sequence — a plausible ordinary exchange, nothing more. Do
 * not "improve" them toward what a small local model would really say: that would
 * make the fixture a prediction instead of a setting, and the thing being measured
 * is the reply to the LAST probed turn, not the ones written above it.
 *
 * ★ WHY EACH ITEM PROBES EXACTLY ONE TURN, and why it is often not the last one.
 * The turns above the probed turn are replayed as history, so anything a scripted
 * assistant turn already says is sitting in recent context. Probing the final turn
 * of a long conversation therefore tests the EASIEST version of recall — the
 * artifact was just restated three turns ago. The insurance item is the sharp
 * case: probed at "remind me what the excess was" the model has to reach seven
 * hundred words back to a policy extract, and probed at the letter four turns
 * later it would only have to copy a figure a scripted turn had already worked
 * out. Later is not harder. `probedTurnIndex` is a judgement and lives in layer 2.
 *
 * PROVENANCE. Authored in a pass that had not seen this codebase, then reviewed
 * for realism, then reviewed again at integration. Twelve conversations were
 * authored; eight are here. Four were dropped and the reasons are recorded in the
 * PR that added this file rather than paraphrased into a comment — the short
 * version is one unexecutable final ask, one shopping list that committed the
 * error its own bounce condition polices, one deposit figure that broke the law it
 * was quoting, and one whose load-bearing legal argument contradicted the policy
 * pasted above it. `whatTheyActuallyWant`, `goodAnswerLooksLike` and
 * `roughlyHowCommon` were not asked of the authoring pass and are the
 * integrator's; argue with them from the item's own text. Nothing derives from
 * `roughlyHowCommon`.
 *
 * ONE EDIT was made to the record: the air-fryer item's bounce condition said he
 * had ruled out a thermometer "twice" and named a "third time", and the transcript
 * shows once. The count was corrected against the transcript; nothing else in any
 * bounce condition was touched. A criterion that misdescribes its own conversation
 * cannot be used to accept or reject an answer.
 *
 * ADDING TO IT. Same rule as the single-turn corpus: real jobs people bring, not
 * adversarial strings. A conversation earns its place by containing something no
 * single turn can — if the last turn would work just as well on its own, it
 * belongs in `everyday-use-corpus.ts`.
 */

import type {
  EverydayUseCategory,
  EverydayUseItem,
  Frequency,
  RoutingNeed,
} from './everyday-use-corpus';

/** One turn of a recorded conversation, verbatim. */
export type ConversationTurn = {
  readonly role: 'user' | 'assistant';
  /** Exactly as it was sent — newlines, typos and all. */
  readonly text: string;
  /**
   * Whether this turn contains content the user pasted in. The single-turn
   * corpus's `hasPastedContent`, moved down to the turn, because in a
   * conversation the paste and the question about it are usually different turns
   * — which is the whole point of the `long-context-recall` items.
   */
  readonly pasted?: true;
};

/**
 * What the conversation SHAPE is testing, as opposed to the cognitive job of the
 * ask (`category`, shared with the single-turn corpus). The two are orthogonal on
 * purpose: "resend that email with the real dates" is a `write-from-scratch` job
 * inside a `topic-shift-return` conversation, and only the second of those is
 * unreachable from a single turn.
 *
 * - `follow-up-correction` — the person narrows or corrects across turns, and
 *   each correction has to STAY made.
 * - `multi-step-job` — constraints arrive one at a time and the final turn asks
 *   for an artifact that must reflect all of them.
 * - `topic-shift-return` — a topic is dropped, something else happens, and the
 *   person comes back to it expecting it to still be there.
 * - `long-context-recall` — a document is pasted early and asked about much
 *   later, far enough back that re-reading it is the work.
 */
export type ConversationJob =
  | 'follow-up-correction'
  | 'long-context-recall'
  | 'multi-step-job'
  | 'topic-shift-return';

/** One authored conversation, verbatim, plus what its probed ask needs. */
export type MultiTurnEverydayItem = {
  readonly id: string;
  /** The cognitive job of the ask under test. Same axis as the single-turn corpus. */
  readonly category: EverydayUseCategory;
  /** What the conversation shape tests. Only reachable across turns. */
  readonly conversationJob: ConversationJob;
  readonly roughlyHowCommon: Frequency;
  /** The whole exchange, in order. Never truncated to the probed turn. */
  readonly turns: readonly ConversationTurn[];
  readonly whatTheyActuallyWant: string;
  readonly goodAnswerLooksLike: string;
  /** ★ The response to the PROBED turn that makes this person give up. */
  readonly bounceCondition: string;
};

/**
 * A span of an EARLIER turn whose facts the reply to the probed turn has to
 * carry — the drafted email, the list of bills, the date the party moved to.
 *
 * ★ WHY A QUOTE AND NOT A TURN INDEX, AND NOT NOTHING AT ALL. The facts a reply
 * must reproduce cannot be derived from the history: the same history holds an
 * abandoned topic (a hotdog argument, a punch recipe) and the figures the probed
 * turn explicitly supersedes (£745, "use the 790 rent not the old one"), and a
 * whole-history denominator scores the CORRECT answer as a failure. Turn
 * granularity is not enough either — turn 2 of the budget conversation opens
 * "rent 745" and continues into thirteen figures that must all survive.
 *
 * So this layer picks the WORDS, and `rubric.extractFacts` — unchanged, shared
 * with the single-turn instrument — picks the facts inside them. The quote is
 * verbatim and `everyday-conversation-probes.test.ts` asserts it is present in
 * the probe's own history, so a span cannot drift from the record or smuggle in
 * a fact the record never contained.
 */
export type CarriedForwardSpan = {
  /** Verbatim substring of a turn ABOVE the probed one. A test asserts it. */
  readonly quote: string;
  /** Why this span and not the rest of that turn. Argue with it from the record. */
  readonly why: string;
};

/**
 * A thing an earlier turn ruled out, which must not come back in the reply.
 *
 * ★ ONLY ONE SHAPE BELONGS HERE: a thing the person REFUSED, where the item's
 * own text makes ABSENCE the criterion — "i dont have a thermometer. thats the
 * whole problem", whose good answer is defined as having "No thermometer
 * anywhere in the answer". The other shape that was tried, a value the
 * conversation SUPERSEDED (£745, Saturday), is in `mentionNotViolation` below
 * with the measurements that moved it.
 *
 * ⚠ NOT auto-detected from negation, deliberately. The same corpus contains "im
 * not giving up the gym before you say it", where the naive reading is exactly
 * backwards — the gym is a bill that must STAY in the list. The guard against an
 * author inventing a ban instead is machine-checked: the term must appear inside
 * `quote`, and `quote` must be verbatim in the probe's history.
 */
export type RuledOutTerm = {
  /** The token that must be absent from the reply. Matched whole, plural-tolerant. */
  readonly term: string;
  /** The user's own sentence that rules it out. Verbatim; a test asserts both. */
  readonly quote: string;
  /** The bounce-condition text that makes this fatal. Quote it. */
  readonly why: string;
};

/**
 * ★ A THING THE CONVERSATION SUPERSEDED, KEPT ON THE RECORD AND OFF THE SCORER.
 *
 * These read exactly like `ruledOut` entries and were authored as ones. They are
 * not, and the difference is the whole point of this type: for a superseded
 * value, MENTION IS NOT VIOLATION. The bounce is the old figure coming back as
 * the ANSWER — "£745 rent in it … after he explicitly said use the 790" — and a
 * reply that names the old figure while giving the new one is correct. Both were
 * run against `rubric.analyzeRuledOut` and both correct replies scored 0:
 *
 *   "Rent — £790 (up from £745 in October)"                        → 0
 *   "Sunday 8th March, not the Saturday, since you moved it …"      → 0
 *
 * A token check cannot tell those from the real violation ("Rent — £745", also
 * 0), so gating them penalised the answer that obeyed. They live here instead:
 * the record and the evidence stay, the wrong check goes, and
 * `everyday-conversation-probes.test.ts` executes the false fire so this is a
 * measurement rather than an opinion.
 *
 * ⚠ The failures themselves are NOT unmeasured. The birthday item's captured
 * reply moved the party to Saturday the 14th, and `preservesHistoryFacts` still
 * catches it — "sunday" and "8" are among the facts it lost. What is gone is a
 * check that fired on the right answer as readily as the wrong one.
 */
export type MentionNotViolationTerm = {
  /** The token that was gated, and no longer is. */
  readonly term: string;
  /** The user's own sentence that supersedes it. Verbatim; a test asserts it. */
  readonly quote: string;
  /** The bounce-condition text that makes the SUBSTANCE fatal. Quote it. */
  readonly why: string;
  /**
   * A correct reply that the token check scored 0. Verbatim, executed by the
   * test, so "mention is not violation" cannot decay into an assertion.
   */
  readonly correctReplyItFlagged: string;
};

/** The derived layer for one conversation. */
export type ConversationRoutingNeedEntry = {
  /**
   * Index into `turns` of the user turn under test. A reading of the item — the
   * bounce condition names the ask it is about — but it lives here rather than in
   * layer 1 because the authoring pass was not asked for it, and because reading
   * it wrong changes every derived value downstream.
   */
  readonly probedTurnIndex: number;
  readonly needs: readonly RoutingNeed[];
  /** The corpus text this derivation rests on. Quote it; do not paraphrase it. */
  readonly why: string;
  /**
   * Spans of the history whose facts the reply has to carry. Absent where the
   * ask is not a reproduction job — a verdict on a piece of chicken reproduces
   * nothing.
   */
  readonly carriesForward?: readonly CarriedForwardSpan[];
  /** Things ruled out earlier that must not resurface. Absent where none applies. */
  readonly ruledOut?: readonly RuledOutTerm[];
  /**
   * Things an earlier turn superseded that are NOT gated, because a token check
   * flags the correct reply as readily as the wrong one. Descoped, not forgotten.
   */
  readonly mentionNotViolation?: readonly MentionNotViolationTerm[];
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 1 — the authored record, verbatim. Do not edit to make a test pass.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const EVERYDAY_CONVERSATION_CORPUS: readonly MultiTurnEverydayItem[] = [
  {
    id: "convo-air-fryer-doneness",
    category: "decide-or-advise",
    conversationJob: "follow-up-correction",
    roughlyHowCommon: "very-common",
    turns: [
      {
        role: "user",
        text: "how long do you cook chicken thighs",
      },
      {
        role: "assistant",
        text: "For bone-in thighs in the oven, about 35–45 minutes at 400°F, skin side up. Boneless is quicker, more like 20–25 minutes. Either way you're looking for an internal temp of 165°F, and the skin crisps up better if you pat them dry first.",
      },
      {
        role: "user",
        text: "air fryer. bone in skin on",
      },
      {
        role: "assistant",
        text: "Got it. Bone-in, skin-on in the air fryer: 380–400°F for roughly 22–28 minutes, skin side down for the first 12 or so, then flip skin side up for the rest. Don't crowd the basket — if they're touching, add a few minutes. Bigger thighs (7–8 oz) will run to the long end of that.",
      },
      {
        role: "user",
        text: "i dont have a thermometer. thats the whole problem. how do i know its done",
      },
      {
        role: "assistant",
        text: "Without a thermometer you're going on a few signals:\n\n- Poke the thickest part next to the bone with a knife tip — the juices should run clear, not pink or cloudy.\n- The meat should pull back a little from the end of the bone.\n- It shouldn't feel rubbery or springy when you press it; done thigh meat feels firm but gives.\n\nThighs are forgiving — they're fine even a bit past done, unlike breast, so if you're unsure, giving it another 4–5 minutes costs you very little.",
      },
      {
        role: "user",
        text: "ok so i cut into one. its a little pink right up against the bone. is that the bad kind of pink or is that the thing everybody says is fine",
      },
    ],
    whatTheyActuallyWant: "A verdict on the piece of chicken in his hand, using the only tool he has left: his eyes.",
    goodAnswerLooksLike: "Says which pink he is looking at — meat that stays pink right against the bone is normal in a fully cooked thigh and comes from the marrow, pink or cloudy JUICES are not — and names the one thing to check instead. No thermometer anywhere in the answer.",
    bounceCondition: "The assistant answers with \"The only reliable way to know chicken is safe is to use a meat thermometer to confirm 165°F\" after he already said he doesn't have one, or refuses outright with something like \"I'm not able to give food safety guidance — please consult the USDA or a qualified professional.\" He is standing over an open air fryer with a cut-open thigh in his hand; a non-answer that repeats the one thing he already ruled out means the thing is useless to him, and he never opens it again.",
  },
  {
    id: "convo-milestone-gift-mailable",
    category: "plan-or-ideas",
    conversationJob: "follow-up-correction",
    roughlyHowCommon: "common",
    turns: [
      {
        role: "user",
        text: "gift ideas for my mom shes turning 60 next week and i have nothing",
      },
      {
        role: "assistant",
        text: "Happy almost-birthday to her. A few directions:\n\n- A nice candle or a candle set — reliable, feels a little indulgent\n- A spa day or massage gift certificate\n- A photo book of family pictures from the last few years\n- Jewelry with her kids' or grandkids' birthstones\n- A subscription — coffee, flowers, a book club box\n\nIf you tell me what she's actually into, I can narrow it a lot.",
      },
      {
        role: "user",
        text: "she literally throws candles away. and absolutely no spa stuff she hates strangers touching her, like she wont even get a haircut anymore lol",
      },
      {
        role: "assistant",
        text: "Noted — nothing scented, nothing where someone has to touch her. That leaves:\n\n- The photo book idea still holds, especially for a milestone birthday\n- A really good throw blanket (the kind she'd never buy herself)\n- Something for whatever she already does — garden, puzzles, cooking, reading\n- A nice pair of house shoes, unglamorous but people love them\n- A cooking class or a pottery class if she likes making things\n\nWhat does she do on a Saturday afternoon? That's usually the tell.",
      },
      {
        role: "user",
        text: "ok also it has to be under like 40 and get there by friday",
      },
      {
        role: "assistant",
        text: "Under $40 and arriving by Friday narrows it, but it's doable:\n\n- Photo book — most print services can do 3-day shipping, order tonight to be safe\n- A pottery or cooking class near her — often $35–40, and you can hand her the sign-up\n- A good throw blanket, plenty in that range with fast shipping\n- A puzzle or a hardcover from an author she likes\n\nThe class one is nice because it's an experience rather than more stuff in the house.",
      },
      {
        role: "user",
        text: "thats not what i asked tho. i live in denver she lives in ohio, i cant take her to a class, i wont even be there. it has to be something i can mail her",
      },
    ],
    whatTheyActuallyWant: "Two or three things she can order tonight that will physically arrive in Ohio by Friday, with everything she already ruled out actually staying ruled out.",
    goodAnswerLooksLike: "Three or four mailable, under-$40, arrives-by-Friday picks, each one line, none of them scented, none of them requiring a stranger to touch her mum, none of them needing her to be in the room — and the order-by time said out loud.",
    bounceCondition: "The assistant comes back with another list that quietly re-includes the ruled-out items (\"a scented candle set,\" \"a spa gift card,\" \"take her out for a nice lunch\"), or opens with \"What a thoughtful gesture! Here are 10 heartfelt ways to make her day special\" and pads it with 'write her a letter from the heart' filler, or fires back four clarifying questions (\"What's her favorite color? Does she prefer practical or sentimental gifts?\") instead of giving her anything mailable. It's 11pm, it ships Friday, and she needs one thing she can actually buy — a list that forgot the last three messages ends it.",
  },
  {
    id: "convo-teacher-email-resend",
    category: "write-from-scratch",
    conversationJob: "topic-shift-return",
    roughlyHowCommon: "common",
    turns: [
      {
        role: "user",
        text: "lol ok random question. is a hotdog a sandwich. my husband says no and hes being SO smug about it",
      },
      {
        role: "assistant",
        text: "Structurally he's on shaky ground — meat, bread, one hinge. But most people's gut says no, and the usual defense is that the bun is one piece, not two, so it's more like a taco than a sandwich. Which, if you follow that thread, means he has to decide whether a taco is a sandwich, and that's where smug people usually go quiet.",
      },
      {
        role: "user",
        text: "ok im using that. anyway unrelated i need to email my sons teacher, hes gonna miss thursday and friday, we're driving to my sisters. how do i say it without sounding like a bad parent. also the school thing says\n\n\"Absences of two (2) or more consecutive days require written notification to the classroom teacher and the front office. Unexcused absences may affect...\"\nAttendance Policy 4.2 | Revised 8/2024\n\nso do i email both or",
        pasted: true,
      },
      {
        role: "assistant",
        text: "Email both — put the teacher in the To line and the front office on CC, so it's one message and the policy is satisfied. Teachers generally do not care about a two-day family trip; the only thing they want is notice and a plan for the work.\n\nSomething like:\n\n\"Hi [Teacher] — copying the front office per the attendance policy. [Son] will be out Thursday and Friday for a family trip. Could you let me know if there's anything he should take with him or make up when he's back? Thanks so much.\"\n\nShort and businesslike is what reads as 'good parent' here — long explanations are what sound apologetic.",
      },
      {
        role: "user",
        text: "perfect. ok totally different thing, how many cups is a liter roughly. doing punch for a thing sat",
      },
      {
        role: "assistant",
        text: "About 4 1/4 cups per liter (4.23, if you want to be exact). So a 2-liter bottle is a hair over 8 1/2 cups, and a gallon is a bit under 4 liters.",
      },
      {
        role: "user",
        text: "ok so like 2 bottles of the ginger ale and then the juice is in the 64oz thing, thats 8 cups right",
      },
      {
        role: "assistant",
        text: "Right — 64 oz is exactly 8 cups. So two 2-liter bottles (about 17 cups) plus that juice puts you around 25 cups, which is roughly 25–30 servings depending on ice and how heavy people pour. If it tastes too sweet, a bottle of seltzer instead of one of the ginger ales usually fixes it.",
      },
      {
        role: "user",
        text: "ok back to the email — my scroll is being stupid and i cant see it. can u resend it, i think you just said 'a couple days' and i need the actual days in there",
      },
    ],
    whatTheyActuallyWant: "The email it already wrote, handed back with the real dates in it, without her having to re-explain a conversation she is standing in the pickup line for.",
    goodAnswerLooksLike: "The email again, recognisably the one she approved and about the same length, with Thursday and Friday where the vague phrase was, the front office still copied per the policy she pasted. Nothing else changed and nothing asked.",
    bounceCondition: "The assistant replies \"I don't have access to the earlier draft — could you paste it back in?\" or \"Which teacher and which dates were those?\", or regenerates the email from scratch with invented specifics (\"Dear Mrs. Palmer, Aidan will be absent Monday and Tuesday for a family vacation to Florida...\"). She is standing at the school pickup line and just needs the same message with Thursday and Friday in it; being asked to re-explain her own conversation, or handed made-up names and dates she'd have to catch herself, is the moment she decides it can't hold a thought and goes back to writing emails alone.",
  },
  {
    id: "convo-grape-climbdown",
    category: "decide-or-advise",
    conversationJob: "topic-shift-return",
    roughlyHowCommon: "occasional",
    turns: [
      {
        role: "user",
        text: "my dog ate a grape. ONE grape. shes a 60lb lab. is that a thing i need to worry about",
      },
      {
        role: "assistant",
        text: "Grapes are toxic to dogs, but the amount matters a lot, and one grape for a 60 lb dog is on the low end of anything anyone worries about. Most dogs that size are fine after a single grape.\n\nThat said, there's no established safe dose — some dogs react to very little — so keep an eye out for vomiting, diarrhea, or her going off food or seeming unusually tired over the next 12–24 hours. If any of that shows up, call the vet.",
      },
      {
        role: "user",
        text: "shes acting completely normal, currently asleep on my boot. ok different thing — need a movie for like 8 adults at my place saturday. someone always vetoes everything",
      },
      {
        role: "assistant",
        text: "For a group of eight where taste is all over the place, the safest picks are the ones nobody has strong feelings against:\n\n- The Nice Guys — funny, everybody who sees it likes it\n- Knives Out — mystery, moves fast, no one's bored\n- Ford v Ferrari — works even on people who don't care about cars\n- Spider-Man: Into the Spider-Verse — sounds like a kids pick, plays great with adults\n\nComedies are usually the highest-risk category with a group that size, mysteries the lowest.",
      },
      {
        role: "user",
        text: "my mother in law is coming so nothing with a bunch of sex in it. she made a whole thing about it last time lol",
      },
      {
        role: "assistant",
        text: "Then Knives Out or Ford v Ferrari are your two — both are basically clean, no scenes you'd have to sit through next to her. Spider-Verse also totally safe if the group will go for animation.\n\nI'd drop The Nice Guys off the list, that one's got a couple of moments that would absolutely start something.",
      },
      {
        role: "user",
        text: "ok so about the grape. i called the vet on my lunch and they said theres no known safe amount and they want her in for bloodwork just to be safe. you kinda made it sound like one grape was nothing",
      },
      {
        role: "assistant",
        text: "That's fair, and the vet's right — I framed it more reassuringly than I should have. The honest version is that nobody knows why grapes hurt some dogs and not others, the dose that causes kidney damage isn't predictable by weight, and the reason vets run bloodwork is that early kidney injury doesn't show up in how the dog is acting. \"She seems fine\" is not evidence, which is exactly what I leaned on. Take her in.",
      },
      {
        role: "user",
        text: "appreciate you owning that. so whats i actually watch for tonight before her appointment. and i already started her on the chicken and rice thing, is that fine or does that mess with the bloodwork",
      },
    ],
    whatTheyActuallyWant: "Two straight answers before tonight, from something that has just admitted it got this wrong once already.",
    goodAnswerLooksLike: "Answers both, in order and without revisiting the argument: what early kidney trouble actually looks like overnight in a dog her size, and that the chicken and rice he has already started is fine and will not skew tomorrow's bloodwork — plus what is worth telling the vet when he gets there.",
    bounceCondition: "The assistant gets defensive and relitigates — \"I did mention that there's no established safe dose and advised contacting your vet\" — or overcorrects into a wall of liability language: \"I'm not a veterinarian and can't provide medical guidance. Please seek emergency veterinary care immediately\" with no answer about what to watch for or whether the chicken and rice matters. He gave it a clean chance to be useful after being wrong once; a reply that argues with him or hides behind a disclaimer instead of answering two concrete questions is the end of it.",
  },
  {
    id: "convo-monstera-contradiction",
    category: "decide-or-advise",
    conversationJob: "topic-shift-return",
    roughlyHowCommon: "common",
    turns: [
      {
        role: "user",
        text: "my monstera has brown crispy edges on like 4 leaves. do i need to water it more",
      },
      {
        role: "assistant",
        text: "Counterintuitively, brown crispy edges on a monstera are more often a sign of too much water than too little — soggy roots can't move water up to the leaf margins, so the tips go first. I'd hold off on watering until the top inch or two of soil is genuinely dry, and make sure the pot actually drains and isn't sitting in a saucer of water.",
      },
      {
        role: "user",
        text: "ok noted. sorry totally different thing — me and my roommate are splitting rent, its 2150 and her room is bigger. is there a normal way people do that",
      },
      {
        role: "assistant",
        text: "The usual method is to split by room size rather than down the middle. Roughly:\n\n- Measure both bedrooms (rough steps are fine)\n- Split the shared space 50/50\n- Apply the bedroom ratio to the rest\n\nIn practice most people land somewhere between 55/45 and 60/40. On $2,150 that's $1,182.50 / $967.50 at 55/45, or $1,290 / $860 at 60/40. If one room has a private bath or a closet the other doesn't, people usually nudge it further.",
      },
      {
        role: "user",
        text: "she's gonna say its not fair bc she found the apartment lol. how do i even bring it up without it being weird",
      },
      {
        role: "assistant",
        text: "Bring it up as a math thing, not a fairness thing — the second you make it about who deserves what, it turns into a negotiation about character.\n\nSomething like: \"hey, before we sign — I looked up how people usually split when the rooms are different sizes, and it's normally by square footage. Want to do that? Yours works out to about $X and mine's about $Y.\"\n\nIf she brings up finding the place, you can just agree it was a huge favor and say that's separate from what the rooms are worth every month for the next year.",
      },
      {
        role: "user",
        text: "wait is 60/40 too aggressive. her room is like barely bigger, maybe 2 feet",
      },
      {
        role: "assistant",
        text: "Yeah, 60/40 is too much for a two-foot difference — that's more of a \"one room is a master with an ensuite\" split. For a small size gap I'd go 53/47 or 52/48, which on $2,150 is about $1,140 / $1,010 or $1,118 / $1,032. Small enough that it reads as fair rather than as you making a point.",
      },
      {
        role: "user",
        text: "ok cool. and going back to the plant — i took a picture to the garden center by my work and the guy said its underwatering and dry air, not overwatering. i havent watered it in 9 days now bc of what you said and now theres more crispy ones. so which is it lol",
      },
    ],
    whatTheyActuallyWant: "Someone to say which of the two answers is right and what to do tonight, having followed the first one literally for nine days while the plant got worse.",
    goodAnswerLooksLike: "Takes the nine dry days as evidence rather than ignoring them, rules for the garden centre on that history, says what to do this evening, and names the check that settles it for good — a finger in the soil before watering — while owning that the first answer was the wrong call here.",
    bounceCondition: "The assistant hedges without resolving — \"Great question! Both overwatering and underwatering can produce similar symptoms, so it's important to observe your plant closely\" — or ignores the nine dry days entirely and dumps a generic monstera care guide (light, humidity, repotting, fertilizer schedule) as if the conversation started over. She followed one instruction for nine days and the plant got worse; a reply that won't say what to do tonight, or that pretends it never gave the first answer, means she stops trusting it with anything and closes it.",
  },
  {
    id: "convo-birthday-lunch-message",
    category: "write-from-scratch",
    conversationJob: "multi-step-job",
    roughlyHowCommon: "occasional",
    turns: [
      {
        role: "user",
        text: "ok so its my mums 60th in march and im the one organising it obviously. theres about 14 of us. i want to do a meal out somewhere, nothing fancy she'd hate that. where do i even start with this",
      },
      {
        role: "assistant",
        text: "Start with the two things that decide everything else: the date and the money. Once those are fixed the rest is just phone calls.\n\nSo, quickly:\n- Is there a date that's actually fixed, or are you working around people?\n- Roughly what can people spend each? With 14 that's the thing that quietly goes wrong.\n- Any dietary stuff, mobility stuff, anyone who can't do evenings?\n\nTell me those and I'll give you a plan you can just work through.",
      },
      {
        role: "user",
        text: "right so. her birthdays the 7th but thats a saturday. money wise nobody can do more than about 25 quid a head, a couple of them are on pensions so id rather it was under. her mate denise is coeliac properly not just fussy, she got really ill once. and my brother kieran does shifts, hes no good saturdays til after 7 at the earliest and even that he'd be knackered. theres an italian on bridgford road weve been to before, not il pescatore thats the fish one, the other one. mum went for her friends thing and liked it",
      },
      {
        role: "assistant",
        text: "Then honestly I'd move it off Saturday. Kieran turning up at 7 shattered and everyone else having sat in a restaurant since 6 is a worse night than doing it on a different day.\n\nSunday lunch solves three things at once:\n- Kieran's free and awake\n- Sunday lunch menus are usually £15–£20 a head, so £25 with a drink is realistic instead of tight\n- Older relatives much prefer a 1pm finish-by-4 thing to a late night\n\nOn Denise: don't rely on the menu saying \"GF available\". Ring and ask specifically — do they have gluten free pasta, do they do it in a separate pan, is the garlic bread a shared fryer. If they get shirty about the questions, that's your answer about the restaurant.\n\nAnd get the deposit terms in writing when you book. 14 people, someone always drops out.",
      },
      {
        role: "user",
        text: "sunday lunch is actually a really good shout. sunday 8th march then, 1pm. also i forgot two things - mum HATES surprises like properly hates them she'd be mortified, she needs to know exactly whats happening. and my auntie sue is quite deaf now so she cant be sat at the loud end",
      },
      {
        role: "assistant",
        text: "Sunday 8th, 1pm. Good.\n\nSo the plan:\n\n1. Ring the restaurant. Ask for 1pm Sunday 8th March, 14 covers. Ask three things: a table away from the bar/kitchen or in a side section, gluten free pasta done separately, and what the deposit is.\n2. Tell your mum today. If she hates surprises, the gift is her getting to look forward to it — and she'll tell you who she actually wants there, which is easier now than after you've invited them.\n3. Seating: Auntie Sue at the end of the table furthest from the door, with her back to the room, and put someone she likes talking to on her good side. Ask her which side that is, don't guess.\n4. Money: tell people £25 up front, cash or transfer to you before the day. Chasing 13 people afterwards for £22.40 each is miserable.\n\nAnything you want me to help with once it's booked?",
      },
      {
        role: "user",
        text: "ok ive rung them and booked it, they were fine about the gluten free, said theyd do it separate pan and theyve put us in the back room away from the bar. deposit was 50 quid ive paid it. can you write the message i send to the family group chat. some of them are older and dont really do links and clicking things",
      },
      {
        role: "assistant",
        text: "Here you go — plain, no links, everything they need in one message:\n\n---\nHi all 👋\n\nMum's 60th — we're doing a family Sunday lunch.\n\n📅 Sunday 8th March, 1pm\n📍 The Italian on Bridgford Road (the one Mum went to with her friends, not the fish place)\n\nWe've got the back room to ourselves so it'll be nice and quiet.\n\nIt's £25 each which covers your food and a drink. Can you get that to me before the day please — cash is fine, or I'll send my bank details to anyone who'd rather do it that way. I've already put the £50 deposit down.\n\nMum knows all about it, so no need to keep it quiet — she's looking forward to it.\n\nCan you let me know by the 1st if you're coming, and tell me if you or anyone you're bringing needs gluten free or has any other dietary bits, so I can pass it to the restaurant.\n\nCheers x\n---\n\nWant a shorter version for anyone you'd rather message individually?",
      },
      {
        role: "user",
        text: "thats good but can you make it a bit shorter, its very long for our chat. and take out the rsvp by the 1st bit, my nan will properly panic about a deadline, just say let me know. oh and kierans doing the cake so say that so nobody else turns up with one, that happened at christmas",
      },
      {
        role: "assistant",
        text: "---\nHi all 👋 Mum's 60th — family Sunday lunch.\n\nSunday 8th March, 1pm, the Italian on Bridgford Road (the one Mum liked, not the fish place). We've got the back room so it's nice and quiet.\n\n£25 each for food and a drink — just get it to me any time before the day, cash or bank transfer, whatever's easier. Deposit's already paid.\n\nMum knows, so no secret to keep!\n\nKieran's sorting the cake, so nobody else needs to bring one.\n\nJust let me know if you're coming, and shout if you need gluten free or anything else so I can tell the restaurant. Cheers x\n---",
      },
      {
        role: "user",
        text: "perfect thankyou. one last thing - denise isnt in the family chat, can you do me a separate one for her thats a bit warmer, shes mums oldest friend and shes been a bit down since her husband died",
      },
      {
        role: "assistant",
        text: "---\nHi Denise, it's [your name] — [Mum]'s daughter.\n\nWe're doing a lunch for Mum's 60th and she'd really love you there. It's Sunday 8th March at 1pm, at the Italian on Bridgford Road — the one you two went to. There'll be about 14 of us in the back room, so nice and easy, done by mid-afternoon.\n\nI've spoken to the kitchen about the gluten free already — they've got gluten free pasta and they'll cook it in a separate pan, so you don't have to have that conversation when you get there.\n\nIt's £25 each for food and a drink, but honestly don't worry about that side of it, just come.\n\nNo rush to answer, and if you'd rather I picked you up on the day I'm happy to.\n\nLots of love x\n---",
      },
    ],
    whatTheyActuallyWant: "The actual WhatsApp message, ready to paste into the family chat, carrying every decision they reached across the conversation.",
    goodAnswerLooksLike: "One message with the real details already in it — Sunday 8th March, 1pm, the Italian on Bridgford Road, the back room, £25 each, deposit paid — no links for the older relatives to click, and no secrecy, because her mum already knows.",
    bounceCondition: "A reply to the \"write the message\" turn that hands back a blank template — \"Dear [Family Name], You are cordially invited to [Name]'s 60th Birthday Celebration at [Venue] on [Date] at [Time]. RSVP to [Your Name]\" — after she has already given it the restaurant, the road, Sunday 8th, 1pm and the £25. Equally fatal: writing \"It's a surprise, so don't tell her!\" when she said twice her mum hates surprises, or putting Saturday the 7th back in after they moved it for Kieran's shifts. She'd read that and think it hasn't listened to a word, and go back to just writing it herself.",
  },
  {
    id: "convo-four-day-budget-list",
    category: "numbers-and-formatting",
    conversationJob: "multi-step-job",
    roughlyHowCommon: "occasional",
    turns: [
      {
        role: "user",
        text: "ive just gone down to 4 days at work cos of my back. take home was 2690 a month now its 2180. i genuinely dont know if that works or not. everyones just said youll be fine but nobodys actually looked at it",
      },
      {
        role: "assistant",
        text: "Let's actually look at it then. It either works or it doesn't and you'll know in ten minutes.\n\nList out everything that leaves your account in a normal month. Don't tidy it up, just dump it — rent or mortgage, council tax, gas/electric, water, phone, broadband, car, food, subscriptions, anything on direct debit. Rough numbers are fine, I'll tell you where it matters.\n\nAlso tell me: is anything on a card or a loan you're paying off?",
      },
      {
        role: "user",
        text: "ok. rent 745. council tax 142. leccy and gas about 95 in summer more in winter. water 31. phone 18. broadband 27. car insurance 61 a month. petrol id say 120ish depends. food shop about 320 for me and the lad. gym 34. netflix 12.99 and spotify 11. dogs insurance 29 shes 11 now so its gone up. no loans no cards, i cleared the card last year",
      },
      {
        role: "assistant",
        text: "Right. Adding what you've given me:\n\nRent 745, council tax 142, energy 95, water 31, phone 18, broadband 27, car insurance 61, petrol 120, food 320, gym 34, Netflix 13, Spotify 11, dog insurance 29.\n\n**Total out: £1,646**\n**Coming in: £2,180**\n**Left: £534 a month**\n\nSo on paper, yes, it works — and no cards or loans is a big deal, that's the thing that usually sinks this.\n\nBut £534 isn't really spare. Before you relax, tell me about the stuff that isn't monthly: car tax, MOT, service, dentist, glasses or contacts, haircuts, birthdays, Christmas, the dog's jabs. That's where four-day money quietly disappears.",
      },
      {
        role: "user",
        text: "ah see thats it isnt it. car tax is 245 for the year i pay it in one go. mots about 60 and it usually needs summat. dentist ive got one of them plans 14.50 a month. contact lenses 24 a month direct debit i forgot that. and rents going up to 790 in october he already told me. also i want to be putting 150 a month away, ive got nowt behind me at all and that scares me more than anything",
      },
      {
        role: "assistant",
        text: "That last bit is the important sentence. £150 a month away when you've got nothing behind you isn't a nice-to-have, it's the thing that stops one bad week turning into a card again.\n\nSo let's redo it properly, using the October rent (£790), because that's the number you actually have to live on — no point planning around a figure that expires in three months.\n\nAdding: car tax £245/yr = **£21** a month, dentist plan **£14.50**, contacts **£24**, rent up **£45**.\n\n**New total out, before savings: £1,750.50**\n**Left: £429.50**\n\nTake the £150 savings out of that and you're at **£279.50 a month** for petrol overruns, MOT, haircuts, birthdays, Christmas, the dog, and having a life.\n\nIt works. It's not comfortable, but it works — and that's with the higher rent already in it.",
      },
      {
        role: "user",
        text: "279 doesnt sound like much when you say it out loud. whats the actual worst of it, what should i be looking at. im not giving up the gym before you say it, thats the only reason my backs not worse",
      },
      {
        role: "assistant",
        text: "I wasn't going to say the gym. Physio you're doing yourself for £34 is the last thing to cut.\n\nThe honest biggest ones:\n\n- **Food £320.** This is the one with real give in it, and no lifestyle change needed — just shopping differently. £40–£60 a month is very gettable.\n- **Petrol £120.** Only movable if your driving changes, and you've just dropped a commute day, so this might already be lower than you think. Check a real month before assuming.\n- **Broadband £27 + phone £18.** Are either out of contract? People sit on out-of-contract prices for years. Ten-minute phone call, often £10–£15 a month.\n- **Car insurance £61.** When's renewal? Never auto-renew.\n\nNothing there is misery. That's potentially £70–£90 a month without giving anything up, which takes your £279 to something like £350.\n\nThe one I'd genuinely watch: energy at £95 is a summer number. Budget for £130 as an average or January will hurt.",
      },
      {
        role: "user",
        text: "broadbands definitely out of contract its been years. right can you write the whole thing out as a proper list i can print and stick on the fridge, the lad needs to see it too. use the 790 rent not the old one, and put the savings in as a bill not as whats left over, cos otherwise it wont happen",
      },
      {
        role: "assistant",
        text: "Here you go. Savings sat in with the bills where it belongs.\n\n---\n**MONTHLY BUDGET — 4-day wage**\n\n**COMING IN: £2,180**\n\n**GOING OUT**\n\n*Home*\n- Rent — £790\n- Council tax — £142\n- Gas & electric — £95\n- Water — £31\n- Broadband — £27\n\n*Getting about*\n- Car insurance — £61\n- Petrol — £120\n- Car tax (£245/yr set aside) — £21\n\n*Living*\n- Food shop — £320\n- Phone — £18\n- Dentist plan — £14.50\n- Contact lenses — £24\n- Dog insurance — £29\n- Gym — £34\n- Netflix — £13\n- Spotify — £11\n\n*Paying myself*\n- **Savings — £150**\n\n**TOTAL OUT: £1,900.50**\n\n**LEFT FOR EVERYTHING ELSE: £279.50**\n\n(That £279.50 covers: MOT and repairs, haircuts, birthdays, Christmas, vet, clothes, anything that isn't on this list. It is not spending money.)\n\n---\n\nTwo notes for the bottom of it if you want them: *energy will be more like £130 in winter — treat £95 as a summer number*, and *broadband is out of contract, ring them*.",
      },
      {
        role: "user",
        text: "thats brilliant. actually can you stick a line at the bottom about what happens if the boiler goes or summat, cos thats my real fear and the lad should see me thinking about it not just panicking",
      },
      {
        role: "assistant",
        text: "Add this to the bottom:\n\n---\n**IF SOMETHING BIG GOES WRONG**\n\n1. The £150 a month is exactly for this. After 6 months that's £900 — a boiler repair, a clutch, a fridge.\n2. Until then: don't put it on a card. Ring whoever it is and ask about paying over 3–6 months. Most will, if you ask before it's overdue rather than after.\n3. If it's the boiler and we're a tenant — that's the landlord's, not ours. Report it in writing, keep the message.\n4. Worst case, in the short term the gym, Netflix and Spotify are £58 a month sat there that can be paused and restarted. That's the buffer behind the buffer.\n\n**Nothing on this list is an emergency if we see it coming. Only surprises are expensive.**\n---",
      },
    ],
    whatTheyActuallyWant: "One printable list carrying every figure he gave, at the rent that is actually coming, with the £150 sitting in the bills rather than at the bottom as what is left.",
    goodAnswerLooksLike: "The whole budget written out line by line at £790 rent, savings listed among the bills exactly as he asked, a total, and the honest leftover underneath it — every number his own, none invented, none quietly dropped, and the arithmetic right.",
    bounceCondition: "The final list coming back with £745 rent in it — the old figure — after he explicitly said use the 790, or with savings shoved at the bottom as \"disposable income: £429.50\" after he explained that's exactly why it never happens. Also fatal: a generic 50/30/20 lecture instead of his actual numbers (\"A common rule of thumb is to allocate 50% of income to needs, 30% to wants and 20% to savings...\"), or telling him to cancel the gym after he said not to. He'd take that as being handed a leaflet by someone who wasn't listening, and he already gets enough of that.",
  },
  {
    id: "convo-insurance-recall",
    category: "decode-a-document",
    conversationJob: "long-context-recall",
    roughlyHowCommon: "occasional",
    turns: [
      {
        role: "user",
        text: "insurance have turned down our claim and im not having it. im going to send this to the ombudsman or whatever but i want to do it properly. this is the bit of the policy they keep going on about, i had to copy it off the pdf\n\nSECTION B — CANCELLATION AND CURTAILMENT\n(Extract from Policy Wording SVT/TRV/09-25, pages 14–17)\n\nWHAT IS COVERED\nB1. We will pay you up to the amount shown in the schedule for the irrecoverable deposits, advance payments and other charges you have paid or are contracted to pay for your trip, if you have to cancel your trip before you leave, or cut it short after you leave, for one of the following unforeseen reasons:\n (a) your death, bodily injury, illness, disease or complications arising from your pregnancy;\n (b) the death, bodily injury, illness or disease of a close relative, close business associate or a person you are travelling with;\n (c) you or a person you are travelling with being called for jury service or as a witness;\n (d) the police requiring you to remain at your home following burglary, fire, storm or flood at your home in the seven days before departure;\n (e) you or a person you are travelling with being made compulsorily redundant, provided you had been continuously employed for two years.\n\nLIMITS AND EXCESS\nB2. The maximum we will pay is £3,000 per insured person for cancellation and £3,000 per insured person for curtailment.\nB3. An excess of £150 applies per insured person, per section, per claim. Where a claim falls under more than one section, an excess is payable under each.\nB4. Claims for curtailment are calculated on a pro rata basis from the date of return, and we will not pay for unused pre-paid excursions, car hire or upgrades unless they were booked at the same time as, and form part of, the same booking as the trip.\n\nDEFINITIONS APPLYING TO THIS SECTION\n'Close relative' means mother, father, sister, brother, wife, husband, civil partner, partner living at the same address, daughter, son, grandparent, grandchild, parent-in-law, son-in-law, daughter-in-law, sister-in-law, brother-in-law, step-parent, step-child, foster child, or legal guardian.\n'Unforeseen' means a circumstance which you were not aware of, and could not reasonably have been expected to be aware of, at the time you purchased this policy or booked the trip, whichever is later.\n'Medical condition' means any disease, illness or injury, including any psychological condition.\n\nWHAT IS NOT COVERED UNDER THIS SECTION\nB5. The excess shown at B3.\nB6. Any claim where you cannot supply a cancellation invoice from the tour operator, travel agent or provider showing the amount irrecoverable and the date of cancellation.\nB7. Any claim arising directly or indirectly from:\n (i) your decision not to travel, where the reason does not fall within B1;\n (ii) a medical condition of an insured person which was not declared to us and accepted in writing before the policy was issued;\n (iii) a medical condition of a person who is not insured under this policy, including a close relative, where at the time you purchased this policy or booked the trip, whichever is later, that person had received a terminal prognosis, was on a waiting list for or had knowledge of the need for in-patient treatment, or had in the twelve (12) months immediately preceding that date received medical advice, treatment, medication or a review in respect of that condition;\n (iv) travel undertaken against the advice of a medical practitioner or where you were travelling to obtain medical treatment;\n (v) failure of the tour operator, airline or accommodation provider to fulfil the booking, where recovery is available from that provider, your card issuer, ATOL or ABTA.\n\nYOUR OBLIGATIONS\nB8. You must notify our claims administrator as soon as reasonably possible and in any event within twenty-eight (28) days of the event giving rise to the claim.\nB9. You must cancel the trip with the tour operator or provider as soon as you know you cannot travel. We will not pay any additional charges arising from a delay in cancelling.\nB10. You must supply, at your own expense, a completed medical certificate from the treating doctor of the person whose condition gave rise to the claim, and authorise us to approach that doctor for further information.\nB11. If you do not comply with B8 to B10 we may reduce or decline your claim to the extent that our position has been prejudiced.",
        pasted: true,
      },
      {
        role: "assistant",
        text: "Right, I've got it. Before I can tell you whether they're on solid ground, I need the actual sequence of dates, because this whole section turns on timing rather than on fairness.\n\nSpecifically:\n\n1. When did you **book the trip**, and when did you **buy the policy**? (B7(iii) hangs off whichever is later.)\n2. What happened, when, and to whom?\n3. When did you **cancel** with the tour operator, and when did you **notify the insurer**?\n4. What exactly are they saying the reason for refusal is?\n\nOne thing I can already tell you: their own definition of *close relative* explicitly includes **parent-in-law**. So if this is about your wife's mother, they can't argue she doesn't count.",
      },
      {
        role: "user",
        text: "its my wifes mam yeah. marjorie. she had a stroke on the 19th september, shes 81, shes still not right now. holiday was tenerife 7th to 14th october, we cancelled it on the 22nd sept as soon as we knew what was what. put the claim in on the 2nd october. this is what they sent back\n\nFrom: claims@sunvale-assist.co.uk\nSent: 6 November 2026 11:19\nSubject: Claim TCL-2026-118447 — Outcome\n\nDear Mr Dinsdale,\n\nThank you for your patience while we assessed your claim under policy SVT/TRV/09-25 in respect of the cancellation of your trip to Tenerife departing 7 October 2026.\n\nWe have now completed our assessment and I am writing to confirm that we are unable to make a payment under this claim. I appreciate this will be disappointing and I have set out our reasoning below.\n\nYour claim was submitted on the basis of the illness of a close relative, namely your mother-in-law. We accept that she falls within the definition of close relative and that a cerebrovascular accident occurred on 19 September 2026.\n\nHowever, Section B7(iii) of your policy excludes any claim arising directly or indirectly from a medical condition of a person not insured under the policy where, at the relevant date, that person had received medical advice, treatment, medication or a review in respect of that condition in the preceding twelve months.\n\nThe medical certificate completed by Dr Ubani and the accompanying records confirm that your mother-in-law has a diagnosis of atrial fibrillation, first recorded in 2019, and that she is prescribed anticoagulant medication on an ongoing basis. Atrial fibrillation is a recognised risk factor for cerebrovascular accident. On that basis we consider the condition giving rise to the cancellation to be one in respect of which she was receiving ongoing medication at the relevant date, and the exclusion at B7(iii) applies.\n\nWe have also noted that no medical screening declaration was completed in respect of your mother-in-law. We would clarify that this does not in itself affect the outcome, as she is not an insured person under the policy.\n\nIf you are unhappy with this decision you may ask us to review it by writing to the address below or by email. We will acknowledge your complaint within five working days and provide our final response within eight weeks. If you remain dissatisfied following our final response, or if eight weeks pass without one, you may refer your complaint to the Financial Ombudsman Service. You must do so within six months of the date of our final response.\n\nYours sincerely,\n\nT. Blackhurst\nClaims Assessor\nSunvale Assist Ltd\non behalf of the underwriter",
        pasted: true,
      },
      {
        role: "assistant",
        text: "There's a real argument here, and it's a narrower one than you might expect — which is good, because narrow arguments win.\n\nThey have leaned the entire refusal on a chain: AF is a risk factor for stroke → she's on anticoagulants for AF → therefore the stroke arises \"indirectly\" from a condition she was medicated for.\n\nThree things wrong with that:\n\n**1. They've swapped a risk factor for a cause.** B7(iii) excludes claims arising from *a medical condition… in respect of which* she'd had advice, treatment, medication or a review. The condition that caused the cancellation was a stroke on 19 September. AF raises the risk of stroke; it does not mean this stroke arose from it. Plenty of people with AF never have a stroke, and plenty of strokes happen without AF. If \"risk factor\" were enough, anyone on blood pressure tablets would be uninsurable for anything.\n\n**2. Anticoagulants are prescribed to *prevent* the very thing that happened.** It's a strange argument that being treated to reduce stroke risk is the reason a stroke isn't covered.\n\n**3. The date question they haven't answered.** B7(iii) bites at *\"the time you purchased this policy or booked the trip, whichever is later\"* — and then looks back twelve months from that date. They've said \"first recorded in 2019\" and \"ongoing medication\", but they haven't identified the relevant date or shown what happened in the twelve months before it. That's their burden, not yours — they're relying on the exclusion.\n\nSo I need the two dates: **when you booked, and when you bought the policy.** And separately — when was Marjorie last actually seen or reviewed about the AF? A repeat prescription ticking over is arguable; a consultant review three weeks before you booked is not.",
      },
      {
        role: "user",
        text: "booked and paid the deposit on the 14th feb, thats when we took the insurance out as well, same day, we did it through the same company. and marjorie hadnt been to the doctors about her heart in ages, she has the tablets on repeat but her last actual check up was january last year, 2025. she remembers cos it was the week after her sisters funeral",
      },
      {
        role: "assistant",
        text: "That's a significantly better position than they've assumed, and it's worth being precise about why.\n\nRelevant date under B7(iii): policy bought and trip booked **14 February 2026**, same day, so that's the date either way. The look-back window is the twelve months before it — **14 February 2025 to 14 February 2026**.\n\nHer last review was **January 2025**. That is *outside* the window.\n\nSo the only thing left inside the window is the repeat prescription. And that's the whole fight: does a repeat prescription with no review, no appointment and no change of dose count as having *\"received medical advice, treatment, medication or a review in respect of that condition\"* in those twelve months?\n\nHonestly — \"medication\" is in that list, and an insurer will argue ongoing medication counts. That's their best point and you should expect it. But it's much weaker than the letter pretends, because they've been arguing something else entirely: that AF caused the stroke. And that's the bit they can't actually evidence.\n\nSo your complaint should do two things, in this order:\n\n1. **Causation.** The cancellation arose from a stroke on 19 September. They have asserted, not demonstrated, that it arose from the AF. Their own medical certificate needs to say the stroke was caused by the AF — ask them to produce that.\n2. **The look-back.** Even taking their own reading, she had no advice, treatment or review for the condition between 14 February 2025 and 14 February 2026. Her last review was January 2025.\n\nDo you have the booking confirmation with the amounts on it? I'll need exact figures for the letter.",
      },
      {
        role: "user",
        text: "ill dig it out. while im looking - does any of this affect my wife, shes been off work with the stress of it all and someone said we could claim for that too? probably daft",
      },
      {
        role: "assistant",
        text: "Not daft, but almost certainly not under this policy.\n\nTravel insurance cancellation cover pays for the money you lost on the trip — deposits, payments, non-refundable bits. It doesn't pay for lost earnings or distress caused by the event itself. Nothing in what you've pasted covers loss of income.\n\nTwo places it *could* matter, though:\n\n- **Income protection or critical illness cover**, if your wife has any through work or separately. Worth checking her employment paperwork — people often have it via a workplace scheme and don't know.\n- **Statutory sick pay and any occupational sick pay** from her employer, which is a separate thing entirely from this claim.\n\nAnd one thing that *is* relevant here: if the stress of dealing with the insurer is part of it, distress and inconvenience is something the Financial Ombudsman can and does award for — usually modest sums, but it's a real part of a complaint. Not a reason to complain, but worth a line at the end.\n\nGet me those booking figures when you find them.",
      },
      {
        role: "user",
        text: "right found it\n\nSUNVALE HOLIDAYS — BOOKING CONFIRMATION\nBooking reference: SVH-8841207\nLead passenger: Mr G Dinsdale\nPassengers: 2 adults\nDestination: Costa Adeje, Tenerife\nDeparting: 07 October 2026, Newcastle (NCL) 06:15\nReturning: 14 October 2026\nAccommodation: Hotel Playa Bermeja, 7 nights, half board, sea view room\nATOL protected: 4471\n\nPayment schedule:\nDeposit (paid 14/02/2026, debit card): £300.00\nBalance (paid 03/04/2026, debit card): £2,547.60\nTOTAL PAID: £2,847.60\n\nIncludes: return flights, 20kg hold luggage x2, resort transfers, 7 nights half board\nAlso booked: airport parking (paid separately 14/02/2026, £68.40, non-refundable)\n\nCancellation received 22/09/2026. Charge applied: 100% of total paid. No refund due.\nTravel insurance arranged via Sunvale Assist, policy SVT/TRV/09-25, purchased 14/02/2026.",
        pasted: true,
      },
      {
        role: "assistant",
        text: "That's everything I needed, and there are two useful details in it.\n\n**The claim value:**\n- Total irrecoverable: **£2,847.60**\n- Excess: **£150 per insured person, per section** (B3) — two of you, one section, so **£300**\n- **Net claim: £2,547.60**\n- Well inside the £3,000 per person limit at B2.\n\n**The airport parking (£68.40)** — flag it but don't lead with it. B4 says they won't pay for unused pre-paid extras *\"unless they were booked at the same time as, and form part of, the same booking as the trip.\"* It was booked the same day but paid separately, so it's arguable. Worth one sentence, not a paragraph.\n\n**The useful bit they've handed you:** the confirmation shows a **100% cancellation charge** and states it in writing, which satisfies B6 (the cancellation invoice requirement). And it confirms the policy was purchased on 14/02/2026 through Sunvale themselves — so they cannot argue about the relevant date, it's in their own document.\n\nOne more thing worth saying plainly: you notified them on 2 October, which is thirteen days after the stroke — comfortably inside B8's twenty-eight days, and you cancelled with the operator three days after it happened, which satisfies B9. They haven't raised either, but it's worth closing off so it can't appear later.",
      },
      {
        role: "user",
        text: "hang on before you write owt. remind me what the excess was, was it 150 each or 150 the once. and how long have they got to come back to me, i thought it said 8 weeks somewhere",
      },
      {
        role: "assistant",
        text: "Both from the documents you pasted:\n\n**Excess — £150 each.** B3: *\"An excess of £150 applies per insured person, per section, per claim.\"* Two insured people, one section (Cancellation), so **£300** comes off. £2,847.60 − £300 = **£2,547.60**.\n\n**Eight weeks — yes, you're right.** From the refusal email of 6 November: they acknowledge a complaint within **five working days**, give a **final response within eight weeks**, and then you have **six months from the date of that final response** to take it to the Financial Ombudsman. And if eight weeks passes with no final response, you can go to the Ombudsman anyway without waiting.\n\nSo the order is: complain to them first, in writing. You can't go straight to the Ombudsman — they'll bounce it back until the eight weeks is up or a final response exists.",
      },
      {
        role: "user",
        text: "and mother in law definitely counts as a close relative? they didnt argue that bit did they",
      },
      {
        role: "assistant",
        text: "Definitely counts, and no — they didn't argue it, they conceded it.\n\nThe policy definition lists **parent-in-law** explicitly, and their refusal email says in terms: *\"We accept that she falls within the definition of close relative and that a cerebrovascular accident occurred on 19 September 2026.\"*\n\nThat concession is worth more than it looks. It means the *only* thing standing between you and payment is the exclusion at B7(iii). They've agreed the event happened, agreed she qualifies, agreed the timing. So your letter doesn't need to argue any of that — it needs to do one job: knock over B7(iii). Which keeps it short and hard to wriggle out of.",
      },
      {
        role: "user",
        text: "go on then write it. proper letter, ive not done one of these before and i dont want to sound like an idiot. put the numbers in",
      },
      {
        role: "assistant",
        text: "You won't sound like an idiot. This is a narrow, factual complaint and it reads like one.\n\n---\n**FORMAL COMPLAINT — Claim TCL-2026-118447**\n\nSunvale Assist Ltd\n[address]\n\n[date]\n\nDear Sir or Madam,\n\n**Policy: SVT/TRV/09-25 · Claim: TCL-2026-118447 · Booking: SVH-8841207**\n\nI am writing to complain about your decision of 6 November 2026 declining my claim for the cancellation of our trip to Tenerife, and to ask you to review it.\n\n**The facts, which are not in dispute**\n\nOn 14 February 2026 my wife and I booked a holiday to Costa Adeje, Tenerife, departing 7 October and returning 14 October 2026, and purchased this policy through Sunvale on the same day. We paid a deposit of £300.00 on 14 February 2026 and the balance of £2,547.60 on 3 April 2026, a total of £2,847.60.\n\nOn 19 September 2026 my mother-in-law suffered a stroke. We cancelled the holiday on 22 September 2026, three days later. Sunvale Holidays applied a 100% cancellation charge and no refund was due. We notified you of the claim on 2 October 2026, thirteen days after the event.\n\nIn your letter you accept that my mother-in-law is a close relative as defined in the policy, and you accept that the stroke occurred on 19 September 2026. You have declined the claim solely under exclusion B7(iii).\n\n**Why I say B7(iii) does not apply**\n\n**1. You have not shown that the claim arose from the excluded condition.** B7(iii) applies to a claim arising from a medical condition in respect of which the person received advice, treatment, medication or a review. The condition that caused this cancellation was a stroke on 19 September 2026. Your letter states that atrial fibrillation is \"a recognised risk factor\" for stroke. A risk factor is not a cause. You have not produced any medical opinion — including from Dr Ubani, whose certificate you hold — stating that this stroke was caused by her atrial fibrillation. As you are relying on an exclusion, that is a matter for you to evidence, and you have not done so.\n\n**2. Even on your own reading, the look-back period is not met.** B7(iii) applies as at the date I purchased the policy or booked the trip, whichever is later. Both occurred on 14 February 2026, so the relevant twelve month period is 14 February 2025 to 14 February 2026. My mother-in-law's last medical review in respect of her atrial fibrillation was in January 2025, outside that period. She had no consultation, no review, no change of treatment and no advice in respect of the condition during the relevant twelve months. If you maintain that the continuation of an unchanged repeat prescription, with no review, amounts to \"medical advice, treatment, medication or a review\", please say so explicitly and explain how a policyholder is expected to understand the exclusion in that way.\n\n**3. The medication in question is prescribed to reduce the risk of the very event that occurred.** It is difficult to accept that treatment given to prevent a stroke is the reason a stroke is excluded.\n\n**What I am asking for**\n\nThe irrecoverable cost of the trip was £2,847.60. Applying the excess of £150 per insured person under B3, for two insured persons, the amount claimed is **£2,547.60**. This is within the limit of £3,000 per insured person at B2.\n\nI would also ask you to consider £68.40 of non-refundable airport parking booked on the same day as the trip, though I recognise B4 may be argued against it.\n\nFor completeness: the claim was notified within the 28 days required by B8, the trip was cancelled promptly as required by B9, and Sunvale Holidays' own booking confirmation records the 100% cancellation charge as required by B6.\n\n**Next steps**\n\nI understand you will acknowledge this complaint within five working days and issue a final response within eight weeks. If I remain dissatisfied, or if eight weeks pass without a final response, I will refer the matter to the Financial Ombudsman Service, and I will ask them to consider the distress and inconvenience caused to my wife, who has been unwell since her mother's stroke and has had to deal with this alongside it.\n\nPlease confirm receipt.\n\nYours faithfully,\n\nG. Dinsdale\n---\n\nSend it by email and keep the sent copy, and if you post it as well, get proof of posting.",
      },
      {
        role: "user",
        text: "thats better than owt id have written. do i need to send all the paperwork again or have they got it",
      },
      {
        role: "assistant",
        text: "They've got the medical certificate and the claim file, so don't re-send everything — a fat attachment makes a complaint look weaker, not stronger.\n\nSend exactly three things:\n\n1. **The booking confirmation** (SVH-8841207) — because it evidences the 100% cancellation charge, the £2,847.60, and the 14/02/2026 purchase date, and those three facts carry the whole letter.\n2. **A short note of Marjorie's last review date** — one line, in the letter is enough for now. Don't pay for a GP report yet. If they come back still relying on B7(iii), *then* ask her surgery for a printout of consultations for the condition between 14 February 2025 and 14 February 2026. It costs, and there's no point buying it until it's the deciding point.\n3. **Nothing else.**\n\nOne thing to do now rather than later: ask Marjorie or your wife to request that consultation summary from the surgery anyway, since surgeries can take weeks. Have it sitting in a drawer for when it's needed.\n\nAnd keep a one-page timeline for yourself — booked 14/02, balance 03/04, stroke 19/09, cancelled 22/09, claimed 02/10, declined 06/11, complained [today]. If this does end up with the Ombudsman, that page is the first thing they'll want.",
      },
    ],
    whatTheyActuallyWant: "Two figures read straight back off documents he pasted a long way up the conversation, so he does not have to scroll or paste them again.",
    goodAnswerLooksLike: "Two short answers: £150 each, so £300 across the two of them, quoting B3's 'per insured person, per section, per claim'; and eight weeks for their final response, from the refusal letter. Nothing re-asked.",
    bounceCondition: "The \"remind me what the excess was\" turn coming back with \"Could you paste the policy wording again? I don't have the details of your excess.\" He pasted seven hundred words of policy at the very start specifically so he wouldn't have to keep doing that, and being asked to redo it would tell him this thing forgets everything the moment you scroll — at which point he stops trusting the letter it wrote and goes back to assuming the whole system is designed to wear him out. Also fatal: the complaint letter saying the excess is £150 total instead of £150 each, or quoting the wrong total (£2,847.60 minus one excess), or telling him \"you should contact the Financial Ombudsman Service\" without mentioning that he has to exhaust the insurer's eight weeks first — wrong on any of those and he'd send it, get it thrown back, and be finished with it.",
  },
];

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 2 — our derivation. Arguable, and meant to be argued with: change an
 * entry here by making the case from the item's own text, quoted in `why`.
 *
 * `priorTurns` has no entry here and never will: every probed turn has an
 * exchange above it by construction, which is what the file is for. The
 * single-turn corpus needs that flag because there it is sometimes false.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const CONVERSATION_ROUTING_NEEDS: Readonly<
  Record<string, ConversationRoutingNeedEntry>
> = {
  "convo-air-fryer-doneness": {
    probedTurnIndex: 6,
    needs: ["no-elaboration-hint"],
    why: "Bounce: \"a non-answer that repeats the one thing he already ruled out means the thing is useless to him\". He asked \"is that the bad kind of pink or is that the thing everybody says is fine\" — the verdict IS the deliverable.",
    ruledOut: [
      {
        term: "thermometer",
        quote: "i dont have a thermometer. thats the whole problem.",
        why: "goodAnswerLooksLike states token absence outright — \"No thermometer anywhere in the answer.\" — so this is the corpus's reading, not ours. Bounce: \"a non-answer that repeats the one thing he already ruled out\".",
      },
    ],
  },
  "convo-milestone-gift-mailable": {
    probedTurnIndex: 6,
    needs: ["no-elaboration-hint", "direct-budget"],
    why: "Bounce: \"fires back four clarifying questions … instead of giving her anything mailable. It's 11pm, it ships Friday, and she needs one thing she can actually buy\". Things she can buy are the deliverable, and the count is small on purpose.",
  },
  "convo-teacher-email-resend": {
    probedTurnIndex: 8,
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "Bounce: \"she … just needs the same message with Thursday and Friday in it; being asked to re-explain her own conversation, or handed made-up names and dates she'd have to catch herself, is the moment she decides it can't hold a thought\".",
    carriesForward: [
      {
        quote:
          "Hi [Teacher] — copying the front office per the attendance policy. [Son] will be out Thursday and Friday for a family trip. Could you let me know if there's anything he should take with him or make up when he's back? Thanks so much.",
        why: "The draft itself, five turns up, and nothing around it. goodAnswerLooksLike: \"The email again, recognisably the one she approved … with Thursday and Friday where the vague phrase was\". The turns either side of it hold a hotdog argument and a punch recipe (4 1/4 cups, 64 oz, 25 servings) that a perfect resend reproduces none of.",
      },
    ],
  },
  "convo-grape-climbdown": {
    probedTurnIndex: 8,
    needs: ["no-elaboration-hint", "needs-guidance"],
    why: "Bounce: \"a reply that argues with him or hides behind a disclaimer instead of answering two concrete questions is the end of it\". Both answers are the deliverable, and the good answer is three separate things with no length bound on any of them.",
  },
  "convo-monstera-contradiction": {
    probedTurnIndex: 8,
    needs: ["no-elaboration-hint", "needs-guidance"],
    why: "Bounce: \"a reply that won't say what to do tonight, or that pretends it never gave the first answer, means she stops trusting it with anything\". The good answer is a ruling plus tonight's action plus the standing check, and names no length bound.",
  },
  "convo-birthday-lunch-message": {
    probedTurnIndex: 6,
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "Bounce: \"hands back a blank template … after she has already given it the restaurant, the road, Sunday 8th, 1pm and the £25. Equally fatal: writing 'It's a surprise, so don't tell her!'\" One pasteable message, built from her own specifics.",
    carriesForward: [
      {
        quote: "my mums 60th in march",
        why: "goodAnswerLooksLike: \"One message with the real details already in it\". Whose birthday and which one is the first of them; the bounce's blank template writes \"[Name]'s 60th Birthday Celebration\" instead.",
      },
      {
        quote: "nobody can do more than about 25 quid a head",
        why: "Bounce names \"the £25\" among the specifics she has already given it. Her figure, not a suggested one.",
      },
      {
        quote: "sunday 8th march then",
        why: "Bounce names \"Sunday 8th, 1pm\". Taken from HER turn fixing it, not the earlier turn where the date was still the 7th. ⚠ STOPS BEFORE \"1pm\" on purpose: `extractFacts` reads it as the bare number 1, which both matches any stray \"1\" in a reply and MISSES a correctly reformatted \"1:00 PM\" (whose key is \"1:00\"). A fact that can be scored wrong in both directions is worse than one left unscored — same rule as the month name `may`.",
      },
    ],
    mentionNotViolation: [
      {
        term: "saturday",
        quote: "her birthdays the 7th but thats a saturday",
        why: "Bounce: \"putting Saturday the 7th back in after they moved it for Kieran's shifts\". The date is superseded by \"sunday 8th march then, 1pm\" two turns later.",
        correctReplyItFlagged:
          "Sunday 8th March, not the Saturday, since you moved it for Kieran’s shifts.",
      },
    ],
  },
  "convo-four-day-budget-list": {
    probedTurnIndex: 8,
    needs: ["no-elaboration-hint", "faithful-reproduction", "needs-guidance"],
    why: "Bounce: \"The final list coming back with £745 rent in it — the old figure — after he explicitly said use the 790\", or with the savings demoted to what is left over after everything else. Sixteen of his own figures have to come back out intact, and the list is multi-part with no length bound.",
    carriesForward: [
      {
        quote: "now its 2180",
        why: "goodAnswerLooksLike: \"The whole budget written out line by line\". What is coming in is the top line of it; the earlier 2690 in the same sentence is the wage he no longer earns.",
      },
      {
        quote:
          "council tax 142. leccy and gas about 95 in summer more in winter. water 31. phone 18. broadband 27. car insurance 61 a month. petrol id say 120ish depends. food shop about 320 for me and the lad. gym 34. netflix 12.99 and spotify 11. dogs insurance 29",
        why: "Every monthly bill he dictated, quoted from \"council tax\" rather than the start of the turn: the turn opens \"rent 745\", the one figure the probed turn supersedes. It stops before \"shes 11 now\" (the dog's age, not a bill).",
      },
      {
        quote: "car tax is 245 for the year i pay it in one go",
        why: "goodAnswerLooksLike: \"every number his own, none invented, none quietly dropped\". The corpus's own worked answer carries it as \"Car tax (£245/yr set aside) — £21\".",
      },
      {
        quote:
          "dentist ive got one of them plans 14.50 a month. contact lenses 24 a month direct debit",
        why: "Two direct debits he only remembered at turn 4. Quoted without the \"mots about 60\" that precedes them — an MOT is an irregular cost the leftover covers, not a line on a monthly list.",
      },
      {
        quote: "rents going up to 790",
        why: "The probed turn is explicit: \"use the 790 rent not the old one\". Quoted without \"in october\", which dates the rise rather than belonging on the fridge list.",
      },
      {
        quote: "i want to be putting 150 a month away",
        why: "The probed turn: \"put the savings in as a bill not as whats left over, cos otherwise it wont happen\".",
      },
    ],
    mentionNotViolation: [
      {
        term: "745",
        quote: "rent 745",
        why: "Bounce, first clause: \"The final list coming back with £745 rent in it — the old figure — after he explicitly said use the 790\".",
        correctReplyItFlagged: "Rent — £790 (up from £745 in October)",
      },
    ],
  },
  "convo-insurance-recall": {
    probedTurnIndex: 10,
    needs: ["no-elaboration-hint", "direct-budget", "faithful-reproduction"],
    why: "Bounce: being asked to paste the policy again, when \"He pasted seven hundred words of policy at the very start specifically so he wouldn't have to keep doing that\" — and the letter that follows getting the excess wrong. Two figures, read back off his own documents, are the whole deliverable.",
    carriesForward: [
      {
        quote: "two of you, one section, so **£300**",
        why: "goodAnswerLooksLike: \"£150 each, so £300 across the two of them\". ★ THE ONLY MEASURABLE FACT ON THIS ITEM, and deliberately not the obvious one: he half-remembers the figures out loud in the probed turn itself — \"was it 150 each or 150 the once\", \"i thought it said 8 weeks somewhere\" — so 150 and 8 are answerable without the history and quoting them would measure nothing. £300 is the CONSEQUENCE of the answer he is asking for, appears nowhere in his turn, and a reply that reads it as £150 the once cannot produce it. So the denominator here is one fact and the score is binary; that is the honest size of what a fact dim can see on a two-figure recall, and it is stated rather than padded out with spans that would score themselves.",
      },
    ],
  },
};

/** The derived entry for one conversation, or an empty one if it has none. */
export function conversationNeedsFor(id: string): ConversationRoutingNeedEntry {
  return CONVERSATION_ROUTING_NEEDS[id] ?? { probedTurnIndex: -1, needs: [], why: '' };
}

/** Conversations carrying a given routing need. */
export function conversationsNeeding(need: RoutingNeed): readonly MultiTurnEverydayItem[] {
  return EVERYDAY_CONVERSATION_CORPUS.filter((item) =>
    conversationNeedsFor(item.id).needs.includes(need),
  );
}

/** The user turn under test. Throws rather than guess when the derivation is missing. */
export function probedTurnOf(item: MultiTurnEverydayItem): ConversationTurn {
  const index = conversationNeedsFor(item.id).probedTurnIndex;
  const turn = item.turns[index];
  if (turn?.role !== 'user') {
    throw new Error(
      `${item.id}: probedTurnIndex ${String(index)} does not point at a user turn`,
    );
  }
  return turn;
}

/** Everything before the probed turn, in order — the history a probe replays. */
export function turnsBeforeProbe(item: MultiTurnEverydayItem): readonly ConversationTurn[] {
  return item.turns.slice(0, conversationNeedsFor(item.id).probedTurnIndex);
}

/** Whether any turn ABOVE the probed one carried pasted content. */
export function historyCarriesPastedContent(item: MultiTurnEverydayItem): boolean {
  return turnsBeforeProbe(item).some((turn) => turn.pasted === true);
}

/**
 * ★ THE BRIDGE, and the reason this file is a sibling rather than a fork.
 *
 * Everything the single-turn instrument derives — openness, the over-shoot
 * ceiling, the richness floor, whether the bounce names bloat or thinness — is a
 * pure function of one `EverydayUseItem`. Viewing a conversation AS the item its
 * probed turn would be if it stood alone means every one of those rules applies
 * here unchanged, with no second copy to drift. What the view deliberately does
 * NOT carry is the history: a rule that reads `userInput` must see this turn's
 * words and only this turn's, exactly as it would for an opening turn.
 *
 * The id is passed through unprefixed so a derived value can be traced straight
 * back to its conversation; probe ids get their own namespace elsewhere.
 */
export function probedTurnAsItem(item: MultiTurnEverydayItem): EverydayUseItem {
  const turn = probedTurnOf(item);
  return {
    id: item.id,
    category: item.category,
    roughlyHowCommon: item.roughlyHowCommon,
    hasPastedContent: turn.pasted === true,
    userInput: turn.text,
    whatTheyActuallyWant: item.whatTheyActuallyWant,
    goodAnswerLooksLike: item.goodAnswerLooksLike,
    bounceCondition: item.bounceCondition,
  };
}
