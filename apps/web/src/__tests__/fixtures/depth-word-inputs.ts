// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Depth-word false-positive corpus. Authored BLIND (before reading
 * LONG_FORM_RE / DEEP_RE), organised by which alternative each item collides
 * with, and weighted toward what people actually type — duration and
 * possessive uses of "long"/"plan" dominate real usage, so they dominate here.
 *
 * ★ Every one of these routed to `deep` (2048 tokens + "Use clear sections;
 * include concrete recommendations and tradeoffs") before the depth regexes
 * were narrowed on 2026-07-27. 53 out of 53 — not one escaped. Five still do,
 * and each is a deliberate accept rather than a leftover:
 *   - the two turns that literally say "compare" ("can you compare these two
 *     prices for me…", "compare my old rent to the new one…") — the user asked
 *     for a comparison, so `deep` is not a lie, just expensive;
 *   - "is there a strategy for winning at connect four" — an approach question;
 *   - "the step by step instructions in the box are missing a page" — the
 *     "step by step" idiom is kept on purpose;
 *   - "i cant think through all this noise, any tips for focusing" — which is
 *     NOT a depth-regex match at all. It reaches `deep` through PLURALITY_RE
 *     ("tips for"), a different constant this fix never touched.
 *
 * Do NOT edit an item to make a test pass.
 */
export const INNOCENT_DEPTH_WORD_INPUTS: readonly string[] = [
  // "long" — duration questions dominate real usage
  'how long do you boil eggs for hard boiled',
  'how long until my passport arrives',
  'how long should i marinate chicken before grilling',
  'how long does it take to drive from denver to salt lake city',
  'my hair is getting long, when should i book a cut',
  'how long is a football game including halftime',
  'how long can leftover rice stay in the fridge',
  'is a 30 year mortgage too long',
  'how long do i cook a 12 pound turkey',
  'long story short my landlord kept my deposit, what do i do',
  'how long after a tattoo can i swim',
  'why is the wait at the dmv so long',
  // "full"
  'my phone says storage full, what should i delete',
  'what does full coverage insurance actually cover',
  'i work full time and my kid is sick, can i take leave',
  'the moon is full tonight right',
  'my washing machine wont drain when its full',
  'can i get a full refund if i cancel my flight',
  // "complete"
  'i need to complete my taxes by friday, what forms do i need',
  'how do i complete a change of address with usps',
  'the download says complete but i cant find the file',
  'my son needs to complete 40 driving hours, does night driving count',
  // "comprehensive"
  'is comprehensive insurance worth it on a 10 year old car',
  'whats the difference between comprehensive and collision',
  // "detailed"
  'the receipt isnt detailed enough for my expense report, what do i ask for',
  'my doctor sent a detailed bill, what does CPT mean',
  // "thorough"
  'the cleaner wasnt thorough, should i ask for a redo',
  'my dentist said i need a thorough cleaning, is that different from a regular one',
  // "plan" — possessive / scheduling uses
  'my phone plan is 90 dollars a month, is that too much',
  'does my dental plan cover braces',
  'we plan to visit seattle in october, what should we pack',
  'my 401k plan changed providers, do i need to do anything',
  'i plan on quitting my job next month, when do i tell them',
  'whats the best phone plan for two lines',
  'my gym plan auto renewed, can i get out of it',
  // "compare"
  'can you compare these two prices for me, 4.99 for 12oz vs 7.49 for 20oz',
  'how does costco gas compare to shell',
  'compare my old rent to the new one, 1400 vs 1675, how much more per year',
  // "deep"
  'is deep frying a turkey actually dangerous',
  'how do i get a deep stain out of carpet',
  'my dogs cut looks deep, does he need stitches',
  'what is a deep clean at the dentist',
  'how deep should i plant tomato seedlings',
  // "evaluate"
  'the school wants to evaluate my son for an iep, what happens next',
  'my mechanic charges 150 to evaluate the noise, is that normal',
  // "strategy"
  'my kid loves strategy games, what should i get him for christmas',
  'is there a strategy for winning at connect four',
  // "architecture"
  'what architecture style is a house with a big front porch',
  'were touring the architecture in barcelona, how many days do we need',
  // "analyze"
  'the lab is going to analyze my blood work, how long for results',
  'my water company will analyze a sample for free, is it worth doing',
  // idiom collisions
  'the step by step instructions in the box are missing a page',
  'i cant think through all this noise, any tips for focusing',
];

/**
 * Turns that really are asking for depth. These MUST keep routing to `deep`.
 * A candidate that loses one of these is worse than one that keeps a few
 * false positives.
 *
 * Before the 2026-07-27 narrowing, 24/25 routed deep: the last one MISSED,
 * because the old LONG_FORM_RE carried the idiom "in depth" and not "in
 * detail". The narrowed constants take all 25 — the change improved recall as
 * well as precision, so it is not a trade.
 */
export const GENUINE_DEPTH_INPUTS: readonly string[] = [
  'give me a detailed plan for training for a 5k',
  'explain in depth how compound interest works',
  'walk me through step by step how to file a small claims case',
  'i want a thorough comparison of leasing vs buying a car',
  'what are the pros and cons of solar panels',
  'compare the iphone and the pixel for someone who mostly takes photos',
  'analyze my budget and tell me where im overspending',
  'give me a comprehensive guide to starting a vegetable garden',
  'whats the best strategy for paying off three credit cards',
  'help me think through whether to move closer to my parents',
  'what are the tradeoffs between a gas and an induction stove',
  'evaluate these two job offers for me',
  'i need a full breakdown of what closing costs actually include',
  'explain the architecture of how the internet actually works',
  'give me a complete list of everything i need for a newborn',
  'write a detailed itinerary for 5 days in japan',
  'can you do a deep dive on why eggs got so expensive',
  'give me a long explanation, i want to actually understand this',
  'make me a meal plan for the week with a grocery list',
  'what should my strategy be for negotiating salary',
  'compare and contrast the atkins and mediterranean diets',
  'i want a step by step plan to get out of debt',
  'give me a thorough explanation of how mortgages work',
  'analyze the pros and cons of renting vs buying in my situation',
  'explain in detail what happens during a colonoscopy', // missed before the narrowing
];

/**
 * Held-out depth phrasings, written AFTER the narrowed constants existed, to
 * check they did not overfit. They keep 12/15; the old bare-word forms kept
 * 10/15. The three they do not reach are documented misses, not regressions:
 *   - 'give me the full story …'  → `writing`, because WRITING_RE matches bare
 *     `story` (a pre-existing defect this change exposes but does not cause)
 *   - 'what should i consider when choosing a college' → `explain` (also
 *     before the narrowing)
 *   - 'whats the best approach to potty training' → `quick` (also before)
 */
export const HELD_OUT_DEPTH_INPUTS: readonly string[] = [
  'give me the full story on why the roman empire fell',
  'i want the long version',
  'can you go into more detail about the second part',
  'explain it thoroughly please',
  'break down everything i need to know about medicare',
  'what should i consider when choosing a college',
  'help me understand my options for refinancing',
  'i need a really detailed step by step walkthrough of filing taxes myself',
  'give me a comprehensive beginners guide to weightlifting',
  'write me a detailed 7 day itinerary for portugal',
  'whats the best approach to potty training',
  'lay out the tradeoffs of leasing vs financing',
  'do a deep dive into how credit scores are calculated',
  'i want a full comparison of medicare advantage and original medicare',
  'give me a thorough rundown of what to expect at closing',
];

/**
 * Adversarial near-misses used to reject two earlier candidates. The shipped
 * constants match 0/16 of these while keeping all three genuine phrasings
 * below. Kept so a future loosening cannot silently reintroduce them.
 */
export const DEPTH_REGEX_NEAR_MISSES: readonly string[] = [
  'i need to go pay the balance in full before friday',
  'if i go and pay it in full does the interest stop',
  'the dealer said go ahead and pay in full',
  'my review is due, how long should it be',
  'is the full moon tonight',
  'i want a full refund and a written apology',
  'the report card came, what does a 3 mean',
  'i have a long list of chores, how do i get my kid to help',
  'my account history shows a double charge',
  'the tour guide gave a long history of the building',
  'i need the complete address format for canada',
  'his instructions were complete nonsense',
  'the recipe steps are out of order in the app',
  'my workout routine takes 45 minutes, is that enough',
  'the schedule changed again, do i need to tell work',
  'whats a good travel budget for a week in mexico',
];

/** Must still match after any loosening of the verb clause. */
export const DEPTH_REGEX_VERB_CLAUSE_KEEPS: readonly string[] = [
  'explain it thoroughly please',
  'go over it thoroughly with me',
  'can you describe the process thoroughly',
];
