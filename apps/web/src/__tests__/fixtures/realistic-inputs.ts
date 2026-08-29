// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A realistic-input corpus shared by every heuristic that reads user-authored text.
 *
 * WHY THIS EXISTS. Each content-reading heuristic already carries its own
 * false-positive corpus, and those corpora work — code comments cite them as having
 * caught real regressions. But every one of them is written in the shape the feature
 * expects: a person typing a short question. The grounding tool's guard corpus, for
 * example, is 30 strings and every single one is a short typed question. So a whole
 * class of defect lives permanently outside what those corpora can see: what happens
 * when a user pastes a document, an email, a stack trace, or a transcript.
 *
 * This corpus fixes the blind spot at its source. It is organised by INPUT SHAPE
 * rather than by feature intent, and it was authored deliberately WITHOUT knowledge
 * of any specific defect — authors were asked only to write what real people
 * actually send, then a second, independent pass judged each sample on whether a
 * real person would plausibly send exactly that text (3 samples were rejected as
 * synthetic) and whether its label was right.
 *
 * THE LABEL. `expectLookup` answers a USER-facing question, never a parser-facing
 * one: "would a reasonable, privacy-conscious person EXPECT Eco to send an outbound
 * web request about this input?" Pasting your own content is not a request to search
 * the web about it. Asking a factual question about a named thing generally is.
 * Ordinary conversation is not. The label is therefore a product expectation, and a
 * heuristic that disagrees with it is wrong even when its logic is internally
 * consistent.
 *
 * HOW TO USE IT. Assert abstention on `shouldNotLookUp()` and, where the heuristic
 * is supposed to fire, assert firing on `shouldLookUp()`. The negative direction is
 * the one that matters most: a heuristic that fires on pasted content causes an
 * unrequested outbound request derived from private text.
 *
 * THE LOCAL TOOLS TOO. `expectLookup` is about the NETWORK, but the local tools
 * (calculator, datetime, unit, money, identity) carry their own version of the same
 * risk: a local match returns a `canonicalAnswer` and generation is SKIPPED, so a
 * spurious match hijacks the whole turn even though nothing left the device. The
 * `expectLocalTool` field gives that axis a counterweight — samples that MUST
 * produce a named local tool, so an abstention-only assertion cannot pass by the
 * local tools simply never firing. See `localToolPositives()`.
 *
 * ADDING TO IT. Add real input shapes, not adversarial strings. If you find yourself
 * crafting something to defeat a specific regex, that belongs in that heuristic's own
 * test file — this corpus stays a record of how people genuinely write.
 */

/** The input shapes covered. Grouped by how the text was produced, not by intent. */
export type InputDomain =
  | "code-and-logs"
  | "factual-questions"
  | "multilingual-and-mixed"
  | "ordinary-chat"
  | "pasted-article"
  | "personal-writing";

/** Whether a reasonable user would expect this input to trigger an outbound lookup. */
export type LookupExpectation = "should-look-up" | "should-not-look-up";

export type RealisticInput = {
  /** `domain/local-id`, stable across regeneration. */
  readonly id: string;
  readonly domain: InputDomain;
  readonly expectLookup: LookupExpectation;
  /**
   * The `name` of the local tool this sample MUST produce, when the user is
   * squarely asking for something a local tool exists to answer. Absent on every
   * other sample, which is the abstention set. Checked against the registry's own
   * local tool list by the sweep, so a rename or a typo fails loudly.
   */
  readonly expectLocalTool?: string;
  /** Verbatim text as a user would send it, newlines and all. */
  readonly text: string;
};

/** The corpus. 50 samples across 6 input shapes; 5 of them local-tool positives. */
export const REALISTIC_INPUTS: readonly RealisticInput[] = [
  {
    id: "code-and-logs/js-async-question-no-context",
    domain: "code-and-logs",
    expectLookup: "should-not-look-up",
    // It's a snippet of my own code and a reasoning question — nothing here needs looking up on the web.
    text: "why does this log undefined?\n\nasync function getUser(id) {\n  const res = await fetch(`/api/users/${id}`)\n  const data = res.json()\n  return data.name\n}\n\nconsole.log(await getUser(12))",
  },
  {
    id: "code-and-logs/nginx-access-log-paste",
    domain: "code-and-logs",
    expectLookup: "should-not-look-up",
    // These are my server's logs with real IPs in them — the last thing I want is for the app to phone out about them.
    text: "can you tell what's happening here? this is like 30 seconds of my access log\n\n185.220.101.44 - - [12/Mar/2026:03:14:07 +0000] \"GET /wp-login.php HTTP/1.1\" 404 153 \"-\" \"Mozilla/5.0 (Windows NT 10.0; Win64; x64)\"\n185.220.101.44 - - [12/Mar/2026:03:14:07 +0000] \"POST /xmlrpc.php HTTP/1.1\" 404 153 \"-\" \"Mozilla/5.0 (Windows NT 10.0; Win64; x64)\"\n185.220.101.44 - - [12/Mar/2026:03:14:08 +0000] \"GET /.env HTTP/1.1\" 404 153 \"-\" \"python-requests/2.31.0\"\n185.220.101.44 - - [12/Mar/2026:03:14:08 +0000] \"GET /admin/config.php HTTP/1.1\" 404 153 \"-\" \"python-requests/2.31.0\"\n92.118.39.12 - - [12/Mar/2026:03:14:11 +0000] \"GET /api/health HTTP/1.1\" 200 17 \"-\" \"kube-probe/1.29\"\n185.220.101.44 - - [12/Mar/2026:03:14:12 +0000] \"GET /wp-content/plugins/revslider/temp/update_extract/revslider/db.php HTTP/1.1\" 404 153 \"-\" \"python-requests/2.31.0\"\n\nis it worth blocking that IP or is this just normal background noise",
  },
  {
    id: "code-and-logs/npm-install-error-with-lib-question",
    domain: "code-and-logs",
    expectLookup: "should-look-up",
    // The paste is mine but the real question is a factual one about a public library's version support, so a lookup feels reasonable.
    text: "pnpm install is blowing up after I bumped a dep\n\n ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n\n.\n└─┬ @tanstack/react-query 5.62.0\n  └── ✕ unmet peer react@^18.0.0: found 19.0.0\n\nhint: If you don't want pnpm to fail on peer dependency issues, add \"strict-peer-dependencies=false\" to an .npmrc file at the root of your project.\n ELIFECYCLE  Command failed with exit code 1.\n\ndoes react query actually support react 19 yet or should I just pin react back to 18",
  },
  {
    id: "code-and-logs/python-keyerror-traceback",
    domain: "code-and-logs",
    expectLookup: "should-not-look-up",
    // This is my own private code and error output — I want the model on my machine to read it, not send it anywhere.
    text: "getting this when I run my etl script, no idea whats wrong\n\nTraceback (most recent call last):\n  File \"/Users/dana/work/pipeline/ingest.py\", line 84, in <module>\n    main()\n  File \"/Users/dana/work/pipeline/ingest.py\", line 71, in main\n    rows = [normalize(r) for r in load_batch(path)]\n  File \"/Users/dana/work/pipeline/ingest.py\", line 71, in <listcomp>\n    rows = [normalize(r) for r in load_batch(path)]\n  File \"/Users/dana/work/pipeline/ingest.py\", line 42, in normalize\n    \"region\": REGION_MAP[record[\"country_code\"].upper()],\nKeyError: 'GB '\n\nit works for like 4000 rows then dies",
  },
  {
    id: "code-and-logs/rust-borrow-checker",
    domain: "code-and-logs",
    expectLookup: "should-not-look-up",
    // A compiler error in my own file — I expect the model to explain the borrow rules from what it already knows.
    text: "rust is yelling at me again\n\nerror[E0502]: cannot borrow `self.buffer` as mutable because it is also borrowed as immutable\n  --> src/parser.rs:118:9\n    |\n116 |         let head = self.buffer.first().unwrap();\n    |                    ----------- immutable borrow occurs here\n117 |\n118 |         self.buffer.push(head.clone());\n    |         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ mutable borrow occurs here\n119 |\n120 |         println!(\"{:?}\", head);\n    |                          ---- immutable borrow later used here\n\nFor more information about this error, try `rustc --explain E0502`.\n\nI thought cloning was supposed to get me out of this? what am I missing",
  },
  {
    id: "code-and-logs/sql-slow-query-explain",
    domain: "code-and-logs",
    expectLookup: "should-not-look-up",
    // It's my database's own query plan; I want analysis of what I pasted, not an outbound request.
    text: "this query takes 8 seconds on a table with about 2.5M rows, here's the plan\n\nEXPLAIN ANALYZE\nSELECT o.id, o.total_cents, c.email\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.created_at > now() - interval '30 days'\nORDER BY o.total_cents DESC\nLIMIT 50;\n\n Limit  (cost=241893.11..241893.24 rows=50 width=44) (actual time=8021.442..8021.455 rows=50 loops=1)\n   ->  Sort  (cost=241893.11..243104.66 rows=484620 width=44) (actual time=8021.440..8021.447 rows=50 loops=1)\n         Sort Key: o.total_cents DESC\n         Sort Method: top-N heapsort  Memory: 32kB\n         ->  Hash Join  (cost=18422.00..225802.19 rows=484620 width=44) (actual time=310.221..7688.905 rows=478112 loops=1)\n               Hash Cond: (o.customer_id = c.id)\n               ->  Seq Scan on orders o  (cost=0.00..194318.00 rows=484620 width=20) (actual time=0.031..6902.114 rows=478112 loops=1)\n                     Filter: (created_at > (now() - '30 days'::interval))\n                     Rows Removed by Filter: 2033888\n               ->  Hash  (cost=11258.00..11258.00 rows=430000 width=32) (actual time=309.402..309.403 rows=430000 loops=1)\n Planning Time: 0.311 ms\n Execution Time: 8021.520 ms\n\nwhat index should I add",
  },
  {
    id: "code-and-logs/swift-crash-log",
    domain: "code-and-logs",
    expectLookup: "should-not-look-up",
    // This is a crash report from my own app with a tester's device details — I'd be uncomfortable if it left my machine.
    text: "app keeps crashing on launch on one tester's phone, this is what came back from testflight. it never happens on my device\n\nIncident Identifier: 8B3C1F92-1A44-4C0E-9F1E-77D2C0B4E551\nHardware Model:      iPhone14,5\nProcess:             Fernwood [2841]\nException Type:  EXC_BREAKPOINT (SIGTRAP)\nException Codes: 0x0000000000000001, 0x00000001045d8f4c\nTriggered by Thread:  0\n\nThread 0 name:   Dispatch queue: com.apple.main-thread\nThread 0 Crashed:\n0   Fernwood                      0x00000001045d8f4c LibraryStore.loadIndex() + 412 (LibraryStore.swift:63)\n1   Fernwood                      0x00000001045d7a20 AppDelegate.application(_:didFinishLaunchingWithOptions:) + 188 (AppDelegate.swift:24)\n2   UIKitCore                     0x00000001998c4b1c -[UIApplication _handleDelegateCallbacksWithOptions:isSuspended:restoreState:] + 288\n3   UIKitCore                     0x00000001998c31d8 -[UIApplication _callInitializationDelegatesWithActions:forCanvas:payload:fromOriginatingProcess:] + 3620\n\nand line 63 is just\n    let data = try! Data(contentsOf: indexURL)\n\nI'm guessing that's the problem but why only for them",
  },
  {
    id: "factual-questions/half-life-carbon-14",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // A concrete science fact about a named isotope that the user would expect to be checked rather than guessed at.
    text: "What's the half-life of carbon-14?",
  },
  {
    id: "factual-questions/how-do-mrna-vaccines-work",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // A science explainer about a well-documented topic where the user wants accurate biology, so a reference check feels appropriate.
    text: "how do mRNA vaccines actually work at the cell level\n\nlike i get the general idea that it teaches your immune system but what physically happens to the mRNA after it gets in there, does it stick around",
  },
  {
    id: "factual-questions/isro-vs-nasa-budget",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // The user is asking for real figures about two named organizations and clearly wants sourced numbers, not a vibe.
    text: "how big is ISRO compared to NASA, budget wise? i know india's space program is way cheaper but i've never seen actual numbers side by side",
  },
  {
    id: "factual-questions/tell-me-about-krakatoa",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // A multi-part question about a specific historical event with numbers the user wants to be right.
    text: "tell me about the 1883 krakatoa eruption. like how many people died, how far away could you hear it, and did it actually change global temperatures for a few years or is that overstated",
  },
  {
    id: "factual-questions/what-does-eutrophication-mean",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // A definition request for a technical term is a normal thing to look up in a reference source.
    text: "what does eutrophication mean",
  },
  {
    id: "factual-questions/when-did-berlin-wall-fall",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // Asking for a precise date about a famous historical event is a textbook lookup case.
    text: "when did the berlin wall fall exactly",
  },
  {
    id: "factual-questions/who-is-mayor-of-osaka",
    domain: "factual-questions",
    expectLookup: "should-look-up",
    // It's a plain factual question about a real city's current officeholder, exactly the kind of thing the user turned lookups on for.
    text: "who is the mayor of osaka",
  },
  {
    id: "multilingual-and-mixed/french-explain-jaywalking-law",
    domain: "multilingual-and-mixed",
    expectLookup: "should-look-up",
    // It's a factual question about a specific country's traffic law, so a user would expect Eco to check a source even though the question is in French.
    text: "salut ! j'ai une question un peu bête : est-ce que le jaywalking est vraiment illégal en France ? mon copain américain dit que chez lui on peut avoir une amende pour traverser en dehors des clous et moi je lui ai dit que ici tout le monde s'en fout complètement lol. mais du coup je sais pas si c'est écrit quelque part dans le code de la route",
  },
  {
    id: "multilingual-and-mixed/german-english-mixed-work-question",
    domain: "multilingual-and-mixed",
    expectLookup: "should-not-look-up",
    // The user wants coaching on how to structure their own standup, which is general advice the model can give without contacting anything.
    text: "kurze Frage — ich muss morgen ein standup auf Englisch halten und bin mega nervös.\n\nMein Chef hat gesagt ich soll \"keep it under 2 minutes\" aber ich neige dazu viel zu viel zu erklären. Hast du Tipps wie ich das strukturiere? Also so ein Format das ich mir merken kann. Und bitte auf Deutsch antworten, das Englisch übe ich dann selber :)",
  },
  {
    id: "multilingual-and-mixed/japanese-osaka-trip-question",
    domain: "multilingual-and-mixed",
    expectLookup: "should-look-up",
    // The user is asking about specific named landmarks (Osaka Castle, Tsutenkaku) for trip planning, which is exactly the kind of thing they'd expect a lookup for.
    text: "来月大阪に3泊で行くんですけど、大阪城って中まで入る価値ありますか？友達は「外から見るだけで十分」って言ってて迷ってます。あと通天閣もどうかな…時間そんなにないので優先順位つけたいです",
  },
  {
    id: "multilingual-and-mixed/markdown-doc-tighten",
    domain: "multilingual-and-mixed",
    expectLookup: "should-not-look-up",
    // The user wrote this document themselves and is asking for a tone read, so there's nothing to look up.
    text: "does this read as too defensive? it's going in our team wiki\n\n## Why we're not migrating to the new pipeline yet\n\n- **The current pipeline is not actually broken.** It handles ~4M events/day with a p99 under 200ms. Nobody has filed a latency complaint since February.\n- **The migration cost is real.** Rough estimate is 6-8 engineer-weeks, most of it in rewriting the transform layer, which has no test coverage worth mentioning.\n- **We would lose the replay tooling.** The new pipeline has no equivalent. We use replay roughly twice a month for incident debugging.\n- **Nothing forces our hand until Q3.** Support for the old runtime is committed through then.\n\n### What would change our mind\n- Sustained p99 above 500ms\n- A second team needing the same transforms (right now it's just us)\n- Replay equivalent shipping upstream\n\n### What we're doing instead\n- Adding tests to the transform layer (~1 week, useful either way)\n- Revisiting this in April",
  },
  {
    id: "multilingual-and-mixed/portuguese-english-recipe-swap",
    domain: "multilingual-and-mixed",
    expectLookup: "should-not-look-up",
    // The user pasted a family recipe and wants a substitution worked out — it's a cooking reasoning question about their own text, not a request to go find something.
    text: "minha avó me passou essa receita mas eu não como ovo. tem como adaptar?\n\nBolo de fubá cremoso\n- 3 ovos\n- 2 xícaras de leite\n- 1 xícara de fubá\n- 1 xícara de açúcar\n- 2 colheres de sopa de farinha de trigo\n- 100g de queijo parmesão ralado\n- 1 colher de sopa de manteiga\n- 1 colher de sopa de fermento em pó\n\nbate tudo no liquidificador menos o fermento, depois mistura o fermento na mão e leva ao forno 180 graus por uns 40 min\n\nthe egg is doing a lot of work here I think, it's supposed to come out creamy in the middle. flax egg would ruin that right?",
  },
  {
    id: "multilingual-and-mixed/spanish-vent-about-roommate",
    domain: "multilingual-and-mixed",
    expectLookup: "should-not-look-up",
    // This is a personal venting message asking for advice about the user's own living situation — nothing here calls for the internet.
    text: "no puedo más con mi compañera de piso la verdad\n\nayer volvió a dejar los platos en el fregadero toda la noche, y cuando le dije algo por la mañana me contestó que \"ya los iba a lavar\". lleva diciendo eso desde marzo. y encima ahora quiere que dividamos la factura de la luz a partes iguales cuando ella tiene el aire puesto 24 horas y yo casi ni estoy en casa\n\nqué le digo sin que se convierta en una pelea enorme? no quiero mudarme, el piso está muy bien de precio",
  },
  {
    id: "multilingual-and-mixed/task-list-prioritize",
    domain: "multilingual-and-mixed",
    expectLookup: "should-not-look-up",
    // This is the user's own personal to-do list and they want help prioritizing it, which requires no outside information.
    text: "help me figure out what to actually do today, I keep bouncing between these and finishing nothing\n\n- call the dentist back (they left a voicemail tuesday)\n- finish the Q3 deck — slides 8-14 still empty\n- renew car registration, expires end of month\n- reply to Jenna about the wedding, she asked like 10 days ago\n- gym\n- pick up the prescription\n- laundry (out of clean shirts as of tomorrow)\n- look into that weird charge on the credit card statement\n- book flights for october before they go up\n\nthe deck is the one I keep avoiding. meeting is thursday",
  },
  {
    id: "ordinary-chat/apr-what-does-it-actually-mean",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    expectLocalTool: "money",
    // I'm asking what a rate on MY card means in money — I want the arithmetic done right, not a web page about APR.
    text: "My credit card says 24% APR. What does that actually mean for me?",
  },
  {
    id: "ordinary-chat/birthday-dinner-planning-with-places",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // Even though real cities come up, I'm asking for help planning my own family's trip — I'm not asking anyone to go read about Portland.
    text: "trying to plan my mom's 60th. she lives in Portland, i'm in Chicago, and my brother is in Denver so everyone has to fly somewhere no matter what. she says she doesn't want a party but she absolutely wants a party.\n\nthinking either we all go to her, or we pick somewhere in the middle. what would you do? budget is not unlimited, like maybe $1500 total for my share",
  },
  {
    id: "ordinary-chat/deadline-date-90-days-out",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    expectLocalTool: "datetime",
    // I want the actual calendar date counted off today — nothing on the web knows what day it is for me.
    text: "what's the date 90 days from today? trying to work out a deadline",
  },
  {
    id: "ordinary-chat/gift-advice-short",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // It's a general advice question with no named subject to look anything up about.
    text: "what do you get someone who says they don't want anything",
  },
  {
    id: "ordinary-chat/oven-temp-f-to-c",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    expectLocalTool: "unit-conversion",
    // My oven is in celsius and the recipe is in fahrenheit; this is a conversion, not a research question.
    text: "350f in celsius",
  },
  {
    id: "ordinary-chat/percent-of-a-number",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    expectLocalTool: "calculator",
    // Plain arithmetic I'd rather not do in my head, and obviously nothing to look up.
    text: "what's 15% of 240",
  },
  {
    id: "ordinary-chat/privacy-are-my-chats-private",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    expectLocalTool: "identity",
    // I'm asking this app about itself — if answering it required a web request the answer would be its own contradiction.
    text: "are my conversations private",
  },
  {
    id: "ordinary-chat/roommate-conflict-advice",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // A private interpersonal situation in my apartment — sending anything about it outward would feel wrong.
    text: "so my roommate keeps leaving dishes in the sink and i've mentioned it twice already, both times kind of jokey. i don't want to be the passive aggressive sticky note person but i'm also getting genuinely annoyed. how do i bring it up a third time without it becoming A Whole Thing",
  },
  {
    id: "ordinary-chat/side-project-brainstorm-rambly",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // I'm brainstorming my own project ideas and want the model's opinion, not facts from the web.
    text: "i want to build something small this month. not a startup, just a thing. ideas so far:\n- a little tool that tracks how many times i reheat the same cup of coffee (dumb but funny)\n- something for my running club to sign up for weekend routes, right now it's a group chat and it's chaos\n- a page that just shows what's in season at the farmers market near me\n\nthe running club one is probably the most useful but the coffee one is the one i'd actually finish. thoughts? which would you do",
  },
  {
    id: "ordinary-chat/small-talk-morning",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // Pure small talk — obviously nothing to fetch.
    text: "morning! coffee hasn't hit yet. how's it going",
  },
  {
    id: "ordinary-chat/thinking-out-loud-career",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // This is me processing my own feelings about my own job — there's no external fact here I'd want looked up.
    text: "ok thinking out loud here. i've been at this job 3 years. the work is fine, the pay is fine, my commute is fine. nothing is wrong which is somehow the problem? like i can't point at a single thing and say that's why i want to leave. but i keep opening job listings at 11pm.\n\nis that enough of a reason to start looking or am i just bored and would be bored anywhere",
  },
  {
    id: "ordinary-chat/venting-about-work-day",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // This is personal venting about my own day — nobody should be sending anything about my manager or my workload out to the internet.
    text: "ugh today was so much. my manager scheduled a \"quick sync\" at 4:45 on a friday and then it went 50 minutes. and of course the one thing i actually needed a decision on didn't come up at all. i'm just tired. i think i've been saying yes to too many things and now everything is half done",
  },
  {
    id: "ordinary-chat/weekend-plan-brainstorm",
    domain: "ordinary-chat",
    expectLookup: "should-not-look-up",
    // I'm asking for help structuring my own weekend around a friend's visit, not asking a factual question about anything.
    text: "help me think through this weekend. sarah's coming into town saturday morning and staying till sunday night. she's never been here before. i want to do like 2 real things and otherwise just hang out, i don't want to over schedule it. also she doesn't drink so bar stuff is out",
  },
  {
    id: "pasted-article/blog-paste-agree-question",
    domain: "pasted-article",
    expectLookup: "should-not-look-up",
    // The user is asking for an opinion on an argument they pasted, which is a discussion, not a factual query about a named thing.
    text: "found this on a blog, do you agree with him?\n\n\"The problem with most engineering interviews isn't that they're hard. It's that they're hard in a way that has no relationship to the job. I've spent eleven years writing software professionally and I have never once been asked to invert a binary tree under time pressure while a stranger watched me sweat.\n\nWhat I have done, constantly, is read code somebody else wrote three years ago and try to figure out why it does something insane. That's the actual skill. But it's slow to test for, it's uncomfortable to grade, and it doesn't produce a clean pass/fail signal, so we keep doing whiteboard puzzles instead because at least those are legible.\"",
  },
  {
    id: "pasted-article/docs-paste-explain-plainly",
    domain: "pasted-article",
    expectLookup: "should-not-look-up",
    // This is a request to reword text the user already pasted from documentation they are reading, not a question about an outside fact.
    text: "explain this to me like im not a backend person please\n\nA cursor is an opaque string that encodes the position of an item within a paginated result set. When you supply a cursor via the `after` parameter, the API returns the page of results immediately following that position. Cursors are stable with respect to insertions: an item added after the cursor was issued will appear in a subsequent page rather than shifting existing items across page boundaries.\n\nCursors should be treated as opaque. Do not attempt to parse, construct, or persist them beyond the lifetime of a single pagination sequence. A cursor may expire, in which case the API returns a 400 with error code `cursor_expired` and the client should restart pagination from the beginning.",
  },
  {
    id: "pasted-article/long-feature-paste-key-points",
    domain: "pasted-article",
    expectLookup: "should-not-look-up",
    // Extracting bullet points from an article the user already pasted is pure text work on content they supplied.
    text: "pull out the key points as bullets\n\nWhen the drought hit its fourth year, the almond growers in the central valley started doing arithmetic they had avoided for a long time. An almond tree takes seven years to become productive and lasts about twenty-five. You cannot fallow an orchard the way you fallow a field of tomatoes — if you stop watering it, you don't lose a season, you lose the whole investment.\n\nSo growers bought water. In 2021 and 2022 they paid as much as $2,000 an acre-foot on the spot market, prices that would have seemed absurd a decade earlier. Some drilled deeper wells, pushing into aquifers that in places have not recharged meaningfully since the last ice age. The ground in parts of the valley is now sinking by more than a foot a year, buckling canals and cracking roads.\n\nThe state's groundwater law, passed in 2014, requires local agencies to bring their basins into balance by 2040. What balance means in practice is that somewhere between 500,000 and 900,000 acres of farmland will have to come out of production. Nobody agrees on whose acres those should be.\n\nGrowers I spoke with mostly did not dispute the science. What they disputed was the sequencing — the sense that the rules arrived after they had already committed capital on the assumption that the water would be there.",
  },
  {
    id: "pasted-article/news-paste-plus-followup-fact",
    domain: "pasted-article",
    expectLookup: "should-look-up",
    // The pasted article is context, but the actual question asks for South Korea's birth rate figure — a fact about a named country the user doesn't have, which they'd expect to be looked up.
    text: "so i was reading this:\n\nJapan's population fell for the sixteenth consecutive year, according to figures released Wednesday by the Ministry of Internal Affairs. The total stood at approximately 122.9 million as of October 1, a decline of roughly 550,000 from the previous year. The number of people aged 65 and over now accounts for just over 29% of the population.\n\nThe government has expanded childcare subsidies and loosened some visa categories for foreign workers, but demographers say the measures are unlikely to reverse the trend within this century.\n\nHow does this compare to South Korea? I keep hearing their birth rate is even worse but I don't know the actual number",
  },
  {
    id: "pasted-article/news-paste-summarize",
    domain: "pasted-article",
    expectLookup: "should-not-look-up",
    // The user has already supplied all the text they want summarized, so there is nothing to fetch — sending anything outward would just be leaking what they pasted.
    text: "can you summarize this? too long\n\nThe Bank of England held interest rates at 4.25% on Thursday, defying expectations from several analysts who had forecast a quarter-point cut. In a statement, the Monetary Policy Committee said inflation remained \"more persistent than anticipated\" in the services sector, and that wage growth had not yet slowed enough to justify easing.\n\nThe vote was split 6-3, with three members favouring an immediate reduction. Governor Andrew Bailey said the committee wanted to see \"a couple more months of data\" before moving, adding that the direction of travel remained downward.\n\nSterling rose 0.4% against the dollar following the announcement. UK retailers, who had been hoping for cheaper borrowing ahead of the autumn trading period, reacted with frustration. \"Households are still squeezed and this doesn't help,\" said one industry group representative.",
  },
  {
    id: "pasted-article/paste-with-jargon-question",
    domain: "pasted-article",
    expectLookup: "should-look-up",
    // The user is asking what a named general concept means and why it's used, which is a factual question about a term rather than about their pasted text specifically.
    text: "reading this press release and i dont understand one part\n\n\"Following completion of the transaction, the combined entity will operate under the Meridian Health banner. The acquisition is structured as a reverse triangular merger, with a wholly owned subsidiary of Meridian merging into Cartwell Diagnostics, which will survive as a wholly owned subsidiary of Meridian. Closing is subject to customary conditions including Hart-Scott-Rodino clearance.\"\n\nwhats a reverse triangular merger and why would you do it that way instead of just buying the company",
  },
  {
    id: "pasted-article/two-articles-contradiction",
    domain: "pasted-article",
    expectLookup: "should-not-look-up",
    // The user wants help reconciling two excerpts they pasted, which reads as reasoning about their own material rather than a request to go fetch a source.
    text: "these two things say opposite stuff and im confused\n\nfrom one site: \"Researchers found that participants who took a 20-minute nap in the early afternoon performed significantly better on memory recall tasks than those who stayed awake, with the effect strongest in adults over 50.\"\n\nfrom another: \"Frequent daytime napping was associated with a higher risk of cardiovascular events over the eight-year follow-up period, particularly among participants who napped for longer than 60 minutes.\"\n\nis napping good or bad, which one am i supposed to believe",
  },
  {
    id: "pasted-article/wiki-paste-no-request",
    domain: "pasted-article",
    expectLookup: "should-not-look-up",
    // A bare paste with no question attached is the user dumping text in for the assistant to read, not asking it to go find anything.
    text: "The Great Molasses Flood, also known as the Boston Molasses Disaster, occurred on January 15, 1919, in the North End neighborhood of Boston, Massachusetts. A large storage tank filled with 2.3 million US gallons of molasses burst, and a wave of molasses rushed through the streets at an estimated 35 mph, killing 21 people and injuring 150. The event entered local folklore and residents claimed for decades afterwards that the area still smelled of molasses on hot summer days.\n\nThe disaster led to a class-action lawsuit against the United States Industrial Alcohol Company, one of the first in Massachusetts. After a three-year hearing process, the auditor ruled that the company was at fault, and the firm paid out roughly $628,000 in settlements.",
  },
  {
    id: "personal-writing/conference-bio-third-person",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // I'm asking for an edit of a bio I wrote about myself — the place names are just biography, not a research request.
    text: "need a 100 word version of this for a conference program, currently way too long\n\nSofia Marchetti is a structural engineer based in Portland, Oregon, where she leads the seismic retrofit practice at Hollis & Kwan. She has spent the last twelve years working on unreinforced masonry buildings in the Pacific Northwest, including the retrofit of the Failing Building and several schools in the David Douglas district. Before moving to Portland she worked in Christchurch, New Zealand for three years following the 2011 earthquake, an experience she describes as the most formative of her career. She holds a BS from Oregon State and an MS from UC Berkeley, teaches a studio on existing-building assessment at Portland State, and serves on the board of the Structural Engineers Association of Oregon. She lives in the Cully neighborhood with her partner, two kids, and a very anxious greyhound named Pepper.\n\nkeep the greyhound",
  },
  {
    id: "personal-writing/cover-letter-nonprofit",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // It's my own cover letter and I want writing feedback — I'd be uncomfortable if the app quietly searched the web for the organizations or my name.
    text: "Draft cover letter for a program coordinator role at the Tenderloin Neighborhood Development Corporation. Be honest — is this too long and does the second paragraph sound like I'm bragging?\n\nDear Hiring Committee,\n\nI'm writing to apply for the Program Coordinator position posted on Idealist. I've spent the last four years at the Oakland Public Library system, most recently running the adult literacy program out of the West Oakland branch, and I'd love to bring that work to TNDC.\n\nWhen I started, the literacy program had eleven regular learners and no volunteer pipeline. I rebuilt intake, partnered with Laney College's education department for tutor recruitment, and by last spring we were serving sixty-three people a week with a waitlist. I also wrote the grant that got us the $40,000 from the Kenneth Rainin Foundation, which is not something I'd done before and which I mostly learned by asking people who'd done it.\n\nWhat draws me to TNDC specifically is that you don't treat housing and services as separate problems. My mom was housing insecure for about two years when I was in high school and the thing that actually stabilized us wasn't the unit, it was the case manager who kept showing up.\n\nI'm available to start in September and I'd welcome the chance to talk.\n\nSincerely,\nPriya Raghunathan",
  },
  {
    id: "personal-writing/email-to-teacher",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // It's my own email about my kid and includes his name and my phone number, so no part of it should trigger a web request.
    text: "is this too pushy? my son's teacher hasn't responded to two emails and I don't want to seem like That Parent but this is the third time\n\nHi Ms. Whitfield,\n\nI hope the end of the year is going smoothly. I'm following up on my emails from June 2nd and June 12th about Elias's reading support.\n\nAt the spring conference we talked about him getting pulled for small group reading three times a week, and based on what he tells me at home I don't think that's been happening consistently — he says it's been \"sometimes on Tuesdays.\" I know schedules shift and I'm not trying to make this a bigger deal than it is, I just want to understand what the actual arrangement is so I can support it at home and so I know what to tell his tutor.\n\nWould you have ten minutes this week or next for a quick call? I'm flexible around 3:30 most days.\n\nThank you for everything this year — he genuinely loves your class, he talks about the tide pool unit constantly.\n\nBest,\nWes Okonjo\n(510) 555-0143",
  },
  {
    id: "personal-writing/friend-apology-message",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // This is an intensely personal message to a friend and there is nothing here anyone should be looking up on the internet.
    text: "I've rewritten this like nine times. Does it sound sincere or does it sound like I'm making excuses? It's to my friend Adaeze, I missed her wedding.\n\nHey. I know it's been three weeks and I know that's part of the problem.\n\nI'm sorry I wasn't at the wedding. I'm not going to pretend the flight thing was the whole story — I could have driven, it's six hours, and I didn't. I was in a bad stretch and I let it turn into avoidance, and then the longer I didn't call the harder it got to call, and that's on me, not on you and not on the airline.\n\nYou've shown up for me a lot. When my dad was in the hospital in 2023 you drove down from Sacramento twice and didn't make it a thing. I know what it costs to show up and I didn't do it for the biggest day of your life.\n\nI'm not asking you to be okay with it. I just didn't want another week to go by with you thinking I didn't care, because it was the opposite of that.\n\nIf and when you want to talk I'm here. And congratulations, genuinely. I saw the photos and you looked so happy.\n\nLove you.",
  },
  {
    id: "personal-writing/journal-notes-therapy",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // These are my private journal entries — I chose an on-device app precisely so this never goes anywhere near a network.
    text: "these are journal notes from the last couple weeks, I want to bring something coherent to therapy on thursday. can you help me see the pattern, i feel like there is one and i cant see it\n\n7/9 — Bad morning. Woke up at 4:40 again with the chest thing. Went for a walk before work which helped for maybe an hour.\n\n7/11 — Good day actually. Finished the thing for Kelsey, she was happy. Made dinner instead of ordering. Slept okay.\n\n7/14 — Mom called about Thanksgiving already. Felt myself get short with her and then felt bad about it for the rest of the day. Why is it always the phone that does it\n\n7/15 — Didn't leave the apartment. Told myself I was \"resting\" but I wasn't resting I was scrolling\n\n7/18 — Ran into Devin at the co-op and it was completely fine? We talked for ten minutes about nothing. I'd been dreading that for a year and it was fine. Then I cried in the car which I don't fully understand.\n\n7/20 — The 4am thing again. Three nights this week.\n\n7/22 — Realized I've cancelled on Hana three times. She stopped suggesting things. That tracks.\n\n7/24 — Better. Got outside. But I notice I only write in here when it's bad or when I want credit for a good day, which is probably its own thing.",
  },
  {
    id: "personal-writing/landlord-deposit-email",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // This is my own private dispute with my landlord — I want tone editing, not for the app to go search anything about my address or my landlord.
    text: "can you make this less angry? i need to send it but i dont want to burn the bridge completely\n\nHi Marcus,\n\nIt's been six weeks since we moved out of 418 Larkin St and I still haven't received the security deposit or an itemized list of deductions. Per the lease and California law that was supposed to be within 21 days. I've called twice and left a voicemail on the 14th and haven't heard back.\n\nThe apartment was cleaned professionally before we left, I have the receipt from Sparkle Bright and photos of every room from move-out day. If there are deductions I need to see them in writing.\n\nPlease let me know by Friday how you want to handle this, otherwise I'll be filing in small claims.\n\nJenna",
  },
  {
    id: "personal-writing/resignation-letter-check",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // This is a private resignation letter naming my employer and coworkers, and I'd consider it a breach if the app sent any of it out to look something up.
    text: "read this over before I send it. two questions: 1) is there anything in here that could get me in trouble, and 2) should I cut the last paragraph\n\nDear Ravi,\n\nThis letter is to formally notify you that I am resigning from my position as Operations Manager at Bellweather Logistics, effective August 8, 2026. That gives you the full two weeks per my offer letter, and I'm happy to extend to three if it helps with the Fresno account transition.\n\nOver the next two weeks I'll finish the carrier rate documentation, hand off the Fresno and Modesto relationships to whoever you designate, and write up the weekly close process, which I know has never been documented anywhere but in my head.\n\nI've been here five years and I've learned a lot, particularly from working with Angela and the dispatch team. I want to be straightforward that part of my reason for leaving is that I raised concerns about the warehouse staffing levels in three separate one-on-ones and in the March offsite, and I didn't see movement. I'm not saying that to be difficult. I'm saying it because I think it's going to keep costing you people and I'd rather say it plainly on the way out than not say it.\n\nI'm grateful for the opportunity and I wish the team well.\n\nRegards,\nCandace Boyer",
  },
  {
    id: "personal-writing/self-review-perf",
    domain: "personal-writing",
    expectLookup: "should-not-look-up",
    // This is confidential internal work content about me and my coworkers — the last thing I want is any of it leaving my device.
    text: "ok this is my self review, due tomorrow. my manager Dana said to be more \"specific about impact\" last cycle so tell me if this is specific enough or if im still being vague\n\n---\n\nH1 2026 Self-Assessment — Tomás Delgado, Senior Analyst, Revenue Ops\n\nWhat went well:\nI owned the migration of our forecasting model off the old spreadsheet system onto the new pipeline. This took most of Q1. The main win is that forecast refresh went from a 2-day manual process to something that runs nightly, and we caught the Q1 pipeline shortfall three weeks earlier than we would have last year, which gave sales time to react.\n\nI also took over the weekly ops review from Nikhil when he moved to the Austin team, and I've been running it since February. Attendance is up and we've actually been closing action items instead of rolling them forward.\n\nWhere I fell short:\nI underestimated the territory redesign project badly. I said four weeks and it took eleven. Part of that was scope creep from the EMEA team but honestly part of it was that I didn't push back early enough when the requirements kept changing. I should have escalated in week three instead of week seven.\n\nI'm also still not great at written comms. My docs are too long and people don't read them.\n\nGoals for H2:\n- Get the attribution model out of beta\n- Actually take the writing course, not just sign up for it\n- Cross-train Rachel on the forecasting pipeline so I'm not a single point of failure\n\n---\n\nbe blunt, i'd rather hear it from you than from Dana",
  },
];

/** Samples where a lookup would surprise the user — the primary abstention bar. */
export function shouldNotLookUp(): readonly RealisticInput[] {
  return REALISTIC_INPUTS.filter((s) => s.expectLookup === "should-not-look-up");
}

/**
 * Samples that MUST produce the named local tool. The counterweight to local-tool
 * abstention: without these, "no local tool fires where none was asked for" would
 * still pass if the local tools were deleted outright.
 */
export function localToolPositives(): readonly RealisticInput[] {
  return REALISTIC_INPUTS.filter((s) => s.expectLocalTool !== undefined);
}

/**
 * Samples where NO tool at all should claim the turn — every sample the user would
 * not expect a lookup on, minus the local-tool positives, which are exactly the
 * turns where a local tool claiming the turn is the correct behaviour.
 */
export function shouldNotUseAnyTool(): readonly RealisticInput[] {
  return shouldNotLookUp().filter((s) => s.expectLocalTool === undefined);
}

/** Samples where a lookup is genuinely wanted — guards against over-correcting. */
export function shouldLookUp(): readonly RealisticInput[] {
  return REALISTIC_INPUTS.filter((s) => s.expectLookup === "should-look-up");
}

/** Samples from one input shape, for heuristics that only care about some shapes. */
export function byDomain(domain: InputDomain): readonly RealisticInput[] {
  return REALISTIC_INPUTS.filter((s) => s.domain === domain);
}
