// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { DbConversation, DbMessage } from "../../src/lib/db";

/**
 * Conversations the capture lane writes into IndexedDB itself.
 *
 * The app's own `eco-history-fixture` seam installs exactly two fixed
 * conversations. That is enough to prove the seam works and nowhere near enough
 * to photograph the message surface: a markdown showcase, eleven classified
 * error cards, a thinking block and a branch point are all just "a conversation
 * whose message rows say particular things". So this file builds those rows
 * directly, against the app's own `DbConversation` / `DbMessage` types — if the
 * schema moves, type-check fails here rather than a capture silently rendering
 * an empty chat.
 *
 * ── Why the write is safe to race against the app ──────────────────────────
 *
 * `installIdbSeed` runs as an `addInitScript`, so `indexedDB.open('eco-chat')`
 * is called at document-start, before a single line of app JS. IndexedDB
 * serialises connection requests per database and transactions per scope in
 * creation order, and the write transaction is created SYNCHRONOUSLY inside the
 * open request's success handler. The app's own `openEcoDB()` therefore queues
 * behind ours, and the read transaction it creates afterwards cannot start
 * until our write has committed. That ordering is the guarantee — not a sleep,
 * and not luck. (If it were ever violated the entry's assertions would fail the
 * run, because every seeded state asserts on its own seeded content.)
 *
 * ── Determinism rules for anything added here ─────────────────────────────
 *
 * - Ids are frozen strings, never generated. They end up in `data-message-id`,
 *   which `prepare` hooks and element captures select on.
 * - Timestamps are offsets from `CAPTURE_CLOCK_MS`, the same instant
 *   `capture.ts` freezes `Date.now()` to, so "6m ago" renders identically on
 *   every run. Never `Date.now()`.
 * - Message content is the state's whole point: two seeds that differ only in
 *   metadata still need different prose, or the coverage check (rightly) fails
 *   the pair as duplicate pixels.
 */

/**
 * The instant every capture pretends it is — kept byte-identical to
 * `DEFAULT_CLOCK_ISO` in `capture.ts`. Seeded timestamps are offsets from this,
 * so relative times ("6m ago") are stable.
 */
const CAPTURE_CLOCK_MS = Date.parse("2026-03-17T14:32:00-04:00");

const MINUTE = 60_000;

/** A conversation record with the boilerplate filled in. */
function conversation(
  id: string,
  title: string,
  activeLeafId: string,
  preview: string,
): DbConversation {
  return {
    id,
    title,
    createdAt: CAPTURE_CLOCK_MS - 30 * MINUTE,
    updatedAt: CAPTURE_CLOCK_MS - 5 * MINUTE,
    activeLeafId,
    preview,
    pinnedAt: null,
  };
}

/**
 * A finished user + assistant exchange.
 *
 * `extra` is spread onto the assistant row, which is where every interesting
 * state lives (status, citations, truncation, interruption).
 */
function exchange(
  conversationId: string,
  ask: string,
  reply: string,
  extra: Partial<DbMessage> = {},
): DbMessage[] {
  const userId = `${conversationId}-user`;
  const assistantId = `${conversationId}-assistant`;
  return [
    {
      id: userId,
      conversationId,
      parentId: null,
      role: "user",
      content: ask,
      createdAt: CAPTURE_CLOCK_MS - 6 * MINUTE,
      status: "complete",
    },
    {
      id: assistantId,
      conversationId,
      parentId: userId,
      role: "assistant",
      content: reply,
      createdAt: CAPTURE_CLOCK_MS - 5 * MINUTE,
      status: "complete",
      inferenceMethod: "local",
      ...extra,
    },
  ];
}

export type IdbSeed = {
  conversation: DbConversation;
  messages: DbMessage[];
};

/**
 * A single-exchange conversation, which is what nearly every message-surface
 * state is: one ask, one reply, and whatever metadata the reply carries.
 */
function singleExchange(
  id: string,
  title: string,
  ask: string,
  reply: string,
  extra: Partial<DbMessage> = {},
): IdbSeed {
  // The sidebar preview shows what the reader saw, so a reasoning block is
  // stripped the same way the bubble strips it — otherwise the list would show
  // a raw `<think>` tag, which no real preview ever contains.
  const visibleReply = reply.replace(/^<think>[\s\S]*?<\/think>\s*/, "");
  return {
    conversation: conversation(id, title, `${id}-assistant`, visibleReply.slice(0, 80)),
    messages: exchange(id, ask, reply, extra),
  };
}

/**
 * An assistant reply whose whole content is an error card: the bubble renders
 * no prose, and `errorMessage` is what `ErrorMessage.tsx` classifies into one
 * of its titled variants. `content` must stay empty — a card under prose would
 * be a different (and unreal) state.
 */
function errorTurn(id: string, title: string, ask: string, errorMessage: string): IdbSeed {
  return singleExchange(id, title, ask, "", {
    status: "error",
    errorMessage,
  });
}

// ─── Long transcript ────────────────────────────────────────────────────────

/**
 * Sixteen turns of a real conversation, long on purpose.
 *
 * The 4,096-token starter model gives history a budget of about 2,520 tokens
 * once the system prompt and per-turn overhead come out (`selectMessagesForContext`
 * takes 75% of the window, then deducts both). This transcript runs past that —
 * roughly 11,900 characters, near 2,980 tokens — so the app evicts the early
 * turns and draws its ContextDivider partway up, by itself. One seed therefore
 * serves both the "what does a long chat look like" shot and the divider's own.
 * Shortening it would silently delete the divider state.
 */
function longTranscript(): IdbSeed {
  const id = "capture-long-transcript";
  const turns: [string, string][] = [
    [
      "I'm planning a small vegetable bed on a north-facing balcony. Where do I start?",
      "Start with light, because everything else follows from it. A north-facing balcony usually gets bright indirect light rather than direct sun, which rules out the crops people reach for first — tomatoes, peppers, aubergines all want six hours of direct sun and will sulk without it.\n\nWhat does work is anything grown for its leaves: lettuce, rocket, spinach, chard, most soft herbs. They photosynthesise happily in bright shade and bolt less than they would in full sun, so you often get a longer harvest than a sunnier balcony would give you.\n\nMeasure before you buy anything. Stand out there at 9am, noon and 4pm on a clear day and note where the light actually falls; balconies are shaded by their own railings and by the floor above far more than people expect.",
    ],
    [
      "It gets maybe two hours of weak sun in the afternoon. Is that enough for anything?",
      "Two hours of weak afternoon sun plus bright shade the rest of the day is a workable leafy-greens balcony. It is not enough for fruiting crops, and no amount of feeding will change that — fruit is expensive for a plant to make and it needs the light to pay for it.\n\nWithin that budget you have more range than it sounds. Loose-leaf lettuces, mizuna, mustard greens, spinach and chard will all crop. Chives, parsley, mint and coriander do well; coriander in particular prefers not being roasted. Radishes will size up, slowly. Bush beans are the one borderline case worth a try, because they will sometimes surprise you.",
    ],
    [
      "How deep do the containers need to be?",
      "Depth matters more than width for most of these. As a rule of thumb: 15cm for cut-and-come-again salad leaves, 20cm for chard and bush beans, 25–30cm for anything you want to grow to full size or overwinter.\n\nWider and shallower beats narrow and deep for leaves, because the roots run sideways and a broad surface gives you more plants per litre of compost. Whatever you use needs real drainage holes — not decorative ones — and something underneath to catch the runoff, or your downstairs neighbour will find out about your hobby before you tell them.",
    ],
    [
      "What about the weight? It's a rented flat and I don't want to damage anything.",
      "Sensible question, and one most guides skip. Wet compost is roughly a kilogram per litre, so a 40-litre trough weighs about 40kg full — comparable to a person standing in one spot.\n\nTwo things keep that safe. Put the weight near the wall or over the balcony's supporting edge rather than out at the unsupported middle, and spread it across several smaller containers instead of one enormous one. If the balcony is concrete this is almost certainly fine; if it is a timber deck or a Juliet balcony rated for people only, check with the landlord before you load it up.",
    ],
    [
      "Should I buy compost or make my own?",
      "Buy it, at least for the first year. Home composting on a balcony is possible with a bokashi bin or a worm bin, but neither produces the volume you need to fill containers, and both take months before they give you anything.\n\nBuy a peat-free multipurpose compost and mix in about 20% perlite or coarse grit for drainage, because container compost compacts over a season and roots suffocate in the mush. Add a slow-release feed at planting and top up with a liquid feed every couple of weeks once the plants are cropping — containers have no soil reserve to draw on, so you are the entire nutrient supply.",
    ],
    [
      "How often will I need to water?",
      "In containers, more often than you would like, and the answer changes through the year. Spring and autumn, every two or three days. High summer, daily, sometimes twice on a windy day — wind dries a balcony faster than heat does.\n\nCheck rather than schedule: push a finger in to the second knuckle, and water only if it comes out dry. When you do water, water properly until it runs out of the bottom; a splash on the surface trains roots to stay shallow, which is exactly what you do not want. If you travel, a simple wick system with a reservoir bottle will cover four or five days.",
    ],
    [
      "When should I sow, and can I start anything indoors?",
      "For leaves you can sow far earlier and far later than the packets suggest, because you are not waiting on warmth to ripen anything. Rocket, mizuna and spinach germinate happily at 10°C, so a sheltered balcony can start in early March and run into November.\n\nStarting indoors buys you three or four weeks and, more usefully, protects seedlings at the stage when they are most vulnerable — a single slug or one hard rain can wipe out a direct sowing. Sow into modules on a windowsill, then plant out once they have two true leaves and have been hardened off over a week.\n\nThe habit that matters more than timing is succession. Sow a short row every two or three weeks rather than everything at once; otherwise you get a glut, then nothing, and the plants bolt while you are still eating the first batch.",
    ],
    [
      "What usually goes wrong for beginners?",
      "Four things, in roughly this order of frequency.\n\nOverwatering, which looks exactly like underwatering — yellowing, drooping, stalled growth — because a waterlogged root cannot take up water either. The finger test tells the two apart in seconds and almost nobody does it.\n\nUnderfeeding. Container compost is exhausted after six to eight weeks and people assume a struggling plant needs more water when it needs nitrogen.\n\nSowing too thickly. A pinch of lettuce seed is a hundred plants competing in a space that supports eight. Thin ruthlessly; the thinnings are the first harvest.\n\nAnd giving up in August. Most balcony gardens look tired in late summer, and that is the moment to sow the autumn crop rather than the moment to conclude it did not work.",
    ],
    [
      "Do I need to worry about pests up on a balcony?",
      "Less than at ground level, but not none. Height genuinely deters slugs and snails — they can climb, but rarely bother — so the ground gardener's main enemy mostly disappears.\n\nWhat does find you is aphids, which arrive on the wind, and occasionally whitefly. Both are manageable by hand at balcony scale: a firm jet of water or a squash between finger and thumb, repeated every few days for a fortnight, breaks the cycle. Do not reach for a spray; on a balcony you would also be spraying the pollinators that make the trip up, and there are far fewer of them than at ground level.\n\nThe one thing worth actively encouraging is those pollinators. A pot of chives or marjoram left to flower will bring hoverflies, whose larvae eat aphids faster than you can.",
    ],
    [
      "Can I keep anything going through winter?",
      "Yes, and it is the most underrated part of a small garden, because the supermarket alternative is at its worst exactly when your balcony is at its cheapest to run.\n\nLamb's lettuce, winter purslane, land cress and hardy chard all stand through frost in a sheltered spot. They will not grow much between November and February — day length, not temperature, is the limit — so the trick is to sow in late August and let them reach usable size before the light goes. After that you are harvesting from a standing crop rather than growing a new one.\n\nMove containers against the wall for the winter. A wall radiates stored heat overnight and cuts the wind, which is usually worth two or three degrees and, on a balcony, matters more than the frost itself.",
    ],
    [
      "How do I stop the compost drying into a solid block?",
      "That crust is usually a peat-free compost that has been allowed to dry right through, and once it does the water runs down the sides and straight out of the drainage holes without wetting anything. It looks like you watered; nothing did.\n\nThe recovery is to rewet it slowly. Stand the whole container in a tray of water for twenty minutes and let it draw up from below, which is the only reliable way to rehydrate a dried block. Then break the surface up gently with a fork.\n\nPrevention is a mulch. Two centimetres of bark, grit or even spent compost on the surface slows evaporation dramatically, keeps the top layer workable, and on a windy balcony is probably the single cheapest improvement you can make.",
    ],
    [
      "How much does the wind actually matter?",
      "More than almost anything else people plan for, and it is the factor that catches out anyone moving up from a garden.\n\nWind does three things. It dries containers faster than sun does, so watering frequency is driven by exposure rather than temperature. It shreds large soft leaves — chard and lettuce look tattered within a week in a channelled draught. And on an exposed corner it will simply blow light containers over, usually the day after you plant them.\n\nThe fix is a filter, not a wall. A solid screen creates turbulence on its lee side that is often worse than the open wind; something permeable — a trellis, a slatted panel, even a row of taller pots — slows the air without creating an eddy. Aim to break the wind, not stop it.",
    ],
    [
      "Which varieties would you actually pick?",
      "For lettuce, a loose-leaf rather than a heart: 'Salad Bowl' or 'Lollo Rossa' can be cut repeatedly, where a butterhead is one harvest and gone. For spinach in shade, 'Medania' is slower to bolt than most.\n\nChard is where I would spend the effort. 'Fordhook Giant' is heavier cropping than the coloured stems people buy for looks, and it will stand from spring through the following March in a sheltered spot — one sowing, nearly a year of picking.\n\nHerbs: a perennial thyme and a mint, both in their own pots because mint will colonise anything it shares with. Buy those two as plants rather than seed. Parsley, coriander and dill from seed, sown in succession, because their useful life is short however well you treat them.",
    ],
    [
      "Anything I should not bother with?",
      "Sweetcorn, courgettes and pumpkins — all need more root volume, more sun and more water than a balcony can reasonably give, and each takes the space of a dozen lettuces to produce one or two fruits.\n\nCarrots and parsnips are a qualified no. They will grow in a deep container, but supermarket carrots are cheap, excellent and require no effort at all, so the return on the space is poor.\n\nAnd potatoes in bags, which are the classic beginner recommendation and, I think, the classic beginner disappointment. A full bag yields perhaps two meals' worth after four months of watering, and the crop is genuinely indistinguishable from a bag that costs very little. Grow them if you enjoy the tipping-out moment; do not grow them for the potatoes.",
    ],
    [
      "How long before I'm picking anything?",
      "Faster than you expect for leaves. Rocket and mizuna are cuttable at three to four weeks from sowing; loose-leaf lettuce at five or six; radishes at four. Those are real numbers on a shaded balcony, not optimistic packet ones, because none of them are waiting on light to ripen.\n\nChard takes eight to ten weeks to reach picking size, and then keeps going for months, which makes it the best return of anything on the list.\n\nThe habit that shortens all of these is picking early and often. Cut-and-come-again means taking the outer leaves at the size you would actually eat rather than waiting for a full head — the plant keeps producing from the centre, and you start eating a fortnight sooner.",
    ],
    [
      "Is any of this actually cheaper than buying the same veg?",
      "For most crops, honestly, no — and it is worth being straight about that, because the guides that promise savings are usually comparing against organic salad bags and ignoring the compost.\n\nSalad leaves are the genuine exception. A packet of cut-and-come-again seed costs about the same as two bags of supermarket leaves and yields, realistically, twenty or thirty harvests across a season. Soft herbs are similar: a supermarket pot of basil is a fortnight's worth of a plant that should live six months.\n\nEverything else you should grow for other reasons — flavour a shop cannot sell you, the varieties nobody stocks, the fact that it is pleasant. Those are good reasons. Saving money on potatoes is not one of them.",
    ],
  ];

  const messages: DbMessage[] = [];
  let parentId: string | null = null;
  turns.forEach(([ask, reply], index) => {
    const userId = `${id}-user-${String(index)}`;
    const assistantId = `${id}-assistant-${String(index)}`;
    // Two minutes per turn, ending five minutes before the frozen clock.
    const base = CAPTURE_CLOCK_MS - (turns.length - index) * 4 * MINUTE;
    messages.push({
      id: userId,
      conversationId: id,
      parentId,
      role: "user",
      content: ask,
      createdAt: base,
      status: "complete",
    });
    messages.push({
      id: assistantId,
      conversationId: id,
      parentId: userId,
      role: "assistant",
      content: reply,
      createdAt: base + MINUTE,
      status: "complete",
      inferenceMethod: "local",
    });
    parentId = assistantId;
  });

  return {
    conversation: conversation(
      id,
      "Balcony vegetable bed",
      `${id}-assistant-${String(turns.length - 1)}`,
      "For most crops, honestly, no.",
    ),
    messages,
  };
}

// ─── Branch point ───────────────────────────────────────────────────────────

/**
 * One ask with three regenerated replies, which is how the app records "the
 * user pressed Regenerate twice": three assistant rows sharing a parent. The
 * conversation's `activeLeafId` points at the middle one, so the bubble renders
 * `‹ 2 / 3 ›` with both arrows live.
 */
function branchPoint(): IdbSeed {
  const id = "capture-branches";
  const userId = `${id}-user`;
  const replies = [
    "A sourdough starter is flour and water left to ferment until wild yeast and lactic-acid bacteria colonise it. Feed it daily and it becomes a leavening agent you can keep indefinitely.",
    "Think of a starter as a small, stable ecosystem you farm. Equal weights of flour and water, discarded and refreshed each day, until it doubles predictably within four to six hours of feeding — that is when it is strong enough to raise a loaf.",
    "It is a jar of fermented flour paste. Wild yeasts raise the dough and the bacteria make the sour flavour. The whole skill is keeping the two in balance, which you do by feeding it on a rhythm and watching how fast it rises.",
  ];

  return {
    conversation: conversation(id, "Sourdough starter", `${id}-assistant-1`, replies[1] ?? ""),
    messages: [
      {
        id: userId,
        conversationId: id,
        parentId: null,
        role: "user",
        content: "What actually is a sourdough starter?",
        createdAt: CAPTURE_CLOCK_MS - 9 * MINUTE,
        status: "complete",
      },
      ...replies.map((content, index) => ({
        id: `${id}-assistant-${String(index)}`,
        conversationId: id,
        parentId: userId,
        role: "assistant" as const,
        content,
        // Siblings sort by createdAt, so these fix the ‹ 2 / 3 › ordering.
        createdAt: CAPTURE_CLOCK_MS - (8 - index) * MINUTE,
        status: "complete" as const,
        inferenceMethod: "local" as const,
      })),
    ],
  };
}

// ─── Sidebar history ────────────────────────────────────────────────────────

/**
 * A conversation placed at a chosen distance from the frozen clock.
 *
 * Every other seed here answers "what does one conversation look like"; these
 * answer "what does a HISTORY look like". `ConversationList` buckets by
 * `updatedAt` — Today, Yesterday, Previous 7 Days, Older, with pinned rows
 * lifted above all four — so the only way to photograph its group headers is to
 * own that field. `minutesAgo` is an offset from `CAPTURE_CLOCK_MS`, the same
 * instant `capture.ts` freezes `Date.now()` to, which is also what `timeAgo()`
 * subtracts from: "12m ago" and "12d ago" render identically on every run.
 *
 * An entry names as many of these as it wants in one `seed.idb`; each is
 * written by its own document-start script, in the order given, and the LAST
 * one named becomes the active conversation (see `ACTIVE_CONVERSATION_KEY` in
 * capture.ts). That is how a state chooses which row carries the active
 * treatment without touching any other row.
 *
 * The word "winter" is deliberately planted in three of the replies below: the
 * sidebar's search shows one result per conversation, so a single-match query
 * would photograph a one-row list and prove nothing about the highlighting.
 */
function historyConversation(
  id: string,
  title: string,
  ask: string,
  reply: string,
  options: { minutesAgo: number; pinned?: boolean },
): IdbSeed {
  const updatedAt = CAPTURE_CLOCK_MS - options.minutesAgo * MINUTE;
  return {
    conversation: {
      id,
      title,
      createdAt: updatedAt - 12 * MINUTE,
      updatedAt,
      activeLeafId: `${id}-assistant`,
      preview: reply.slice(0, 80),
      pinnedAt: options.pinned === true ? updatedAt : null,
    },
    messages: [
      {
        id: `${id}-user`,
        conversationId: id,
        parentId: null,
        role: "user",
        content: ask,
        createdAt: updatedAt - MINUTE,
        status: "complete",
      },
      {
        id: `${id}-assistant`,
        conversationId: id,
        parentId: `${id}-user`,
        role: "assistant",
        content: reply,
        createdAt: updatedAt,
        status: "complete",
        inferenceMethod: "local",
      },
    ],
  };
}

/** One calendar day, in the `minutesAgo` unit above. */
const DAY_IN_MINUTES = 24 * 60;

// ─── The seeds ──────────────────────────────────────────────────────────────

const MARKDOWN_REPLY = `## Watering a container garden

Containers dry out faster than beds because there is no soil reserve underneath
them. Three things decide how often you water:

1. **Volume.** A 10-litre pot dries in a day; a 40-litre trough takes three.
2. **Exposure.** Wind matters more than heat — a breezy balcony dries faster
   than a still, sunny one.
3. **Plant size.** A mature tomato moves several litres a day through its leaves.

### A rough schedule

| Season | Frequency | Sign you left it too long |
| --- | --- | --- |
| Spring | Every 2–3 days | Leaves dull rather than glossy |
| Summer | Daily | Wilting by mid-afternoon |
| Autumn | Every 3–4 days | Compost pulling from the pot's sides |
| Winter | Weekly, if at all | Rare — overwatering is the winter risk |

> Water until it runs from the drainage holes. A surface splash trains roots to
> stay shallow, which is the opposite of what a container plant needs.

Full details are in the [RHS container guide](https://www.rhs.org.uk/), and the
short version is: check with a finger, not a calendar.`;

const CODE_REPLY = `Here is the smallest version that does what you asked — it reads the file once
and streams the rows rather than holding them all in memory:

\`\`\`python
import csv
from pathlib import Path


def total_by_category(path: Path) -> dict[str, float]:
    """Sum the amount column, grouped by category."""
    totals: dict[str, float] = {}
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            category = row["category"]
            totals[category] = totals.get(category, 0.0) + float(row["amount"])
    return totals


if __name__ == "__main__":
    for category, amount in sorted(total_by_category(Path("spend.csv")).items()):
        print(f"{category:<20} {amount:>10.2f}")
\`\`\`

If the file is large enough that even one pass is slow, the next step is to sort
it externally and aggregate in a single streaming pass — but at a few hundred
thousand rows this version is well within reach.`;

const ARTIFACT_REPLY = `Here is a small self-contained page you can open straight in a browser:

\`\`\`artifact:html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Watering log</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #26221d; }
      h1 { font-size: 1.25rem; }
      li { margin-bottom: 0.35rem; }
    </style>
  </head>
  <body>
    <h1>Watering log</h1>
    <ul id="log"></ul>
    <button id="add">Watered today</button>
    <script>
      const log = document.getElementById("log");
      document.getElementById("add").addEventListener("click", () => {
        const entry = document.createElement("li");
        entry.textContent = new Date().toDateString();
        log.appendChild(entry);
      });
    </script>
  </body>
</html>
\`\`\`

Everything is inline, so there is nothing to install and no build step.`;

const THINKING_REPLY = `<think>The user is asking about a north-facing balcony, so direct sun is the
binding constraint. Fruiting crops need six hours and will not get it. Leafy
crops photosynthesise fine in bright shade and actually bolt less there, so the
honest answer is to reframe the question around leaves rather than fruit —
and to say plainly that tomatoes will not work, instead of hedging.</think>Leafy crops are the honest answer here. Lettuce, rocket, spinach, chard and most
soft herbs all crop well in bright shade, and they bolt less than they would in
full sun — so a north-facing balcony often gives a longer harvest than a sunny
one.

What will not work is anything grown for its fruit. Tomatoes, peppers and
courgettes need around six hours of direct sun to ripen, and no amount of
feeding substitutes for the light.`;

const FILE_REPLY = `Both files parse cleanly. The CSV has 1,204 rows across four categories, and the
notes file is plain UTF-8 with no unusual characters, so nothing needs cleaning
before you load it.

The one thing worth flagging: 18 rows have an empty \`amount\` field rather than a
zero. Depending on what you are counting, those either need dropping or filling —
they are not the same thing.`;

const FILE_ASK = `<file name="quarterly-spend.csv" size="48 KB">
\`\`\`csv
date,category,amount,note
2026-01-04,groceries,62.40,weekly shop
2026-01-05,transport,3.20,bus
\`\`\`
</file>

<file name="reading-notes.txt" size="6 KB">
\`\`\`
Chapter 3 — the argument about containers is really an argument about volume.
\`\`\`
</file>

Can you check whether these two are clean enough to load?`;

/**
 * Every conversation the lane can plant, by name.
 *
 * A manifest entry names one of these in `seed.idb` and the runner writes it
 * before the app boots. Adding one is adding a key here; the name becomes part
 * of the manifest's vocabulary, so treat it as API the way entry ids are.
 */
export const IDB_SEEDS = {
  "conversation-basic": singleExchange(
    "capture-basic",
    "Sleep and afternoon light",
    "Why do I sleep better on days when I've been outside in the morning?",
    "Morning light is the strongest signal your body clock has. Bright light early in the day pulls the clock forward, which brings the evening rise in melatonin forward with it — so you feel sleepy at a sensible hour rather than at midnight.\n\nThe effect is dose-dependent and outdoor light is far brighter than it feels: an overcast morning is still ten to twenty times brighter than a well-lit room. Twenty minutes outside within an hour or two of waking is usually enough to notice within a week.",
  ),

  "conversation-markdown": singleExchange(
    "capture-markdown",
    "Watering schedule",
    "How often should I water my containers, and does it change through the year?",
    MARKDOWN_REPLY,
  ),

  "conversation-code": singleExchange(
    "capture-code",
    "Summing a CSV by category",
    "Write me a short Python function that sums a CSV column grouped by category.",
    CODE_REPLY,
  ),

  "conversation-artifact": singleExchange(
    "capture-artifact",
    "Watering log page",
    "Can you make me a tiny HTML page that logs the days I watered?",
    ARTIFACT_REPLY,
  ),

  "conversation-thinking": singleExchange(
    "capture-thinking",
    "North-facing balcony crops",
    "What can I actually grow on a north-facing balcony?",
    THINKING_REPLY,
  ),

  "conversation-files": singleExchange(
    "capture-files",
    "Checking two attachments",
    FILE_ASK,
    FILE_REPLY,
  ),

  "conversation-long": longTranscript(),

  "conversation-branches": branchPoint(),

  // ── Sidebar history: one conversation per date group ─────────────────────

  "history-pinned": historyConversation(
    "capture-history-pinned",
    "Repotting a fiddle-leaf fig",
    "My fiddle-leaf fig has roots coming out of the drainage holes. Time to repot?",
    "Roots at the drainage holes mean yes, but go up only one pot size — about 5cm wider. A fig moved into a container much larger than its root ball sits in wet compost it cannot drink, and root rot follows within a season.\n\nDo it in spring or early summer while it is actively growing. Repotting in winter asks the plant to recover during the months it has the least light to do it with.",
    { minutesAgo: 40, pinned: true },
  ),

  "history-older": historyConversation(
    "capture-history-older",
    "A reading list for winter",
    "Give me five books to read over winter — nothing bleak.",
    "Winter reading works best when the book is warmer than the weather, so all five below are generous rather than grim.\n\nStart with Penelope Fitzgerald's *The Bookshop* for its dry humour, then Laurie Lee's *Cider with Rosie* for the sunlight. *A Month in the Country* by J. L. Carr is the perfect short one. Add *The Enchanted April* and, if you want something with real momentum, *The Blue Flower*.",
    { minutesAgo: 12 * DAY_IN_MINUTES },
  ),

  "history-week": historyConversation(
    "capture-history-week",
    "Choosing a bike for commuting",
    "What kind of bike should I buy for a five-mile commute?",
    "A steel or aluminium hybrid with mudguards, a rack and 35mm-plus tyres will beat anything sportier over five miles a day. The comfort comes from tyre volume and an upright position, not from the frame material people argue about.\n\nSpend the money on the parts that fail in winter: hydraulic disc brakes, a hub dynamo light, and tyres with a puncture belt. Everything else can be replaced later, when you know what actually annoys you.",
    { minutesAgo: 3 * DAY_IN_MINUTES },
  ),

  "history-yesterday": historyConversation(
    "capture-history-yesterday",
    "Bread without a stand mixer",
    "Can I make decent bread without a stand mixer?",
    "Yes, and for most loaves the mixer is the slower route. A wet dough left alone does the kneading for you: mix flour, water and salt, wait half an hour, then fold the dough over itself four times every thirty minutes for two hours.\n\nThat builds the same gluten a mixer would, with about four minutes of actual work. The one thing a mixer genuinely wins at is enriched dough — brioche is miserable by hand.",
    { minutesAgo: DAY_IN_MINUTES },
  ),

  "history-today": historyConversation(
    "capture-history-today",
    "Sharpening kitchen knives",
    "How do I sharpen kitchen knives properly at home?",
    "A whetstone and about ten minutes will do more for your cooking than a new knife. Soak a 1000-grit stone, hold the blade at roughly fifteen degrees, and draw it across the stone from heel to tip until a burr forms along the whole edge — then repeat on the other side and finish on 3000 grit.\n\nPull-through sharpeners grind away far more steel than they need to. Keep a honing rod by the board for daily use and save the stone for two or three times a year, or once over the winter if you cook less.",
    { minutesAgo: 12 },
  ),

  // ── Grounding: cited, uncertain, and the once-per-chat disclosure ────────

  "conversation-citation": singleExchange(
    "capture-citation",
    "Height of the Eiffel Tower",
    "How tall is the Eiffel Tower?",
    "The Eiffel Tower is 330 metres tall including its antennas — about 300 metres to the top of the structure itself. It held the record for the world's tallest structure from its completion in 1889 until the Chrysler Building overtook it in 1930.",
    {
      citations: [
        {
          id: 1,
          title: "Eiffel Tower",
          url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
          source: "Wikipedia",
          asOf: "2025",
          // A fuzzy tier keeps the chip but never anchors the once-per-chat
          // disclosure — that is what makes this shot the chip alone.
          groundingConfidence: "fulltext",
        },
      ],
    },
  ),

  "conversation-grounding-notice": singleExchange(
    "capture-grounding-notice",
    "Population of Reykjavík",
    "What's the population of Reykjavík?",
    "Reykjavík has a population of roughly 140,000 in the city proper, and about 240,000 across the wider capital region — which is around two thirds of everyone living in Iceland.",
    {
      citations: [
        {
          id: 1,
          title: "Reykjavík",
          url: "https://en.wikipedia.org/wiki/Reykjav%C3%ADk",
          source: "Wikipedia",
          asOf: "2024",
          // "high" is the only tier that earns the disclosure.
          groundingConfidence: "high",
        },
      ],
    },
  ),

  "conversation-uncertainty-unverified": singleExchange(
    "capture-uncertainty-unverified",
    "The first commercial dishwasher",
    "Is it true that the first commercial dishwasher was sold to a hotel?",
    "The usual telling is that Josephine Cochrane's machine, patented in 1886, found its first buyers among hotels and restaurants rather than households — commercial kitchens had the hot water and the volume to make it worthwhile. I could not confirm the specific first sale, so treat the detail as the story rather than the record.",
    { verification: { status: "unverified" } },
  ),

  "conversation-uncertainty-unreachable": singleExchange(
    "capture-uncertainty-unreachable",
    "Marathon world record",
    "What's the current world record for the marathon?",
    "The men's world record has been under two hours and one minute since 2023, and the women's under two hours and twelve. I could not check the current figures just now, so if the exact time matters, confirm it against a live source before quoting it.",
    { verification: { status: "unreachable" } },
  ),

  // ── Turn outcomes ───────────────────────────────────────────────────────

  "conversation-truncated": singleExchange(
    "capture-truncated",
    "Setting up a home network",
    "Walk me through everything I need to set up a small home network.",
    "Start with the router, because everything else hangs off it. The one your provider supplies will work, but its wifi is usually the weakest part — if you have more than a couple of rooms to cover, replacing it or adding a mesh node is the single change that makes the most difference.\n\nRun cable wherever you reasonably can. Anything that does not move — a desktop, a TV, a games console, a printer — is better on ethernet, and every device you take off wifi gives the ones that need it more room.\n\nFor addressing, leave DHCP on but reserve fixed addresses for anything you connect to by name",
    {
      possiblyTruncated: true,
      localCompletionTokens: 512,
      localMaxTokens: 512,
    },
  ),

  "conversation-interrupted-user-stop": singleExchange(
    "capture-interrupted-user-stop",
    "History of the printing press",
    "Explain the history of the printing press.",
    "Movable type existed in China and Korea centuries before Gutenberg — Bi Sheng's ceramic type dates to the 1040s, and Korea was printing with cast metal type by the early 1200s. What Gutenberg added around 1450 was a system rather than a single invention: an oil-based ink that stuck to metal, a hand mould that cast",
    { streamInterrupted: true, interruptedReason: "user-stop" },
  ),

  "conversation-interrupted-fault": singleExchange(
    "capture-interrupted-fault",
    "How a heat pump works",
    "How does a heat pump actually move heat?",
    "A heat pump does not make heat, it moves it — which is why it can deliver more energy than it consumes without breaking any physics. The working fluid evaporates at low pressure outside, absorbing heat even from cold air, and then a compressor",
    { streamInterrupted: true, interruptedReason: "fault" },
  ),

  "conversation-interrupted-empty": singleExchange(
    "capture-interrupted-empty",
    "Summarising the thread",
    "Summarise the last three messages for me.",
    "",
    { streamInterrupted: true, interruptedReason: "restore-detected" },
  ),

  "conversation-offline-divider": singleExchange(
    "capture-offline-divider",
    "A first camera for street photography",
    "What's a good beginner camera for street photography?",
    "Almost any modern compact with a fixed 28mm or 35mm equivalent lens will do the job, and the fixed focal length is a feature rather than a limitation — it stops you fiddling with zoom and makes you move instead.\n\nWhat matters more than the sensor is how quickly the camera wakes and focuses. A camera that takes two seconds to be ready misses the moment you saw, every time.",
    { offlineDivider: true },
  ),

  "conversation-canonical-answer": singleExchange(
    "capture-canonical-answer",
    "Seventeen times twenty-three",
    "What is 17 * 23?",
    "17 * 23 = 391",
    { canonicalToolAnswer: true },
  ),

  // ── The error family ────────────────────────────────────────────────────
  //
  // Each of these seeds the EXACT string `ErrorMessage.tsx` classifies on. The
  // three generic ones exist to show all three hash-selected variants: the
  // seeded string is never displayed (the card's title and body are canned), so
  // the only thing that varies is which of the three it hashes to — verified by
  // running the component's own `hashString` over these literals.

  "error-generic-one": errorTurn(
    "capture-error-generic-one",
    "Thank-you note for a neighbour",
    "Draft a short thank-you note for a neighbour.",
    "The reply could not be completed.",
  ),

  "error-generic-two": errorTurn(
    "capture-error-generic-two",
    "Weeknight dinner ideas",
    "Give me three ideas for a weeknight dinner.",
    "The reply could not be completed just now.",
  ),

  "error-generic-three": errorTurn(
    "capture-error-generic-three",
    "Shortening a sentence",
    "Rewrite this sentence to be shorter.",
    "Something failed while answering.",
  ),

  "error-capacity": errorTurn(
    "capture-error-capacity",
    "Summarising an article",
    "Summarise this article for me.",
    "The request could not be served because the queue was full.",
  ),

  "error-browser-unsupported": errorTurn(
    "capture-error-browser-unsupported",
    "Planning a trip",
    "Hello — can you help me plan a trip?",
    "browser-local-ai-not-supported: This browser doesn't support the graphics features Eco needs to run AI on your device. Safari 18 or a recent Chrome, Edge or Firefox will work.",
  ),

  "error-local-setup": errorTurn(
    "capture-error-local-setup",
    "Gardening weather this week",
    "What's the weather like for gardening this week?",
    "Eco needs to finish preparing the local model before it can answer on this device.",
  ),

  "error-template-missing": errorTurn(
    "capture-error-template-missing",
    "A short story about a lighthouse",
    "Tell me a short story about a lighthouse.",
    "This model's chat template is missing or broken. Open Settings → Eco to re-download it, or pick a different model.",
  ),

  "error-generation-failure": errorTurn(
    "capture-error-generation-failure",
    "Naming a woodworking business",
    "Help me name a small woodworking business.",
    "On-device AI hit a snag. Your conversation is safe — try sending your message again.",
  ),

  "error-generation-repeated": errorTurn(
    "capture-error-generation-repeated",
    "Naming a woodworking business",
    "Help me name a small woodworking business.",
    "On-device AI hit the same snag again. Eco reset the model for a fresh start — if it keeps happening, a lighter model may run better on this device.",
  ),

  "error-cooldown": errorTurn(
    "capture-error-cooldown",
    "Checking my spelling",
    "Can you check my spelling in this paragraph?",
    "On-device AI needs a short breather after a snag. Give it a moment, then send your message again.",
  ),

  "error-model-preparing": errorTurn(
    "capture-error-model-preparing",
    "A good first houseplant",
    "What's a good first houseplant?",
    "Eco is preparing a local model. Wait for it to finish before starting another local model task.",
  ),

  "error-context-window": errorTurn(
    "capture-error-context-window",
    "What should I do next?",
    "Given everything above, what should I do next?",
    "This conversation has grown past what the local model can hold in context. Start a new chat to keep going, or try a shorter question.",
  ),

  "error-device-protection": errorTurn(
    "capture-error-device-protection",
    "Summarising my notes",
    "Can you summarise these notes?",
    "Battery is low, so Eco paused on-device AI to protect this device. Plug in, then try again to keep chatting locally.",
  ),
} satisfies Record<string, IdbSeed>;

export type IdbSeedName = keyof typeof IDB_SEEDS;

export function isIdbSeedName(name: string): name is IdbSeedName {
  return Object.prototype.hasOwnProperty.call(IDB_SEEDS, name);
}

/**
 * The script planted at document-start to write one seed.
 *
 * Kept as a plain function so `capture.ts` can hand it straight to
 * `addInitScript`: it is serialised to the browser, so it may close over
 * nothing and must speak raw IndexedDB rather than the app's `idb` wrapper.
 * The schema mirrors `openEcoDB()` exactly (version 3, both stores, all three
 * indexes) so the app's own open finds the database already current and never
 * runs an upgrade.
 */
export function installIdbSeed(seed: IdbSeed): void {
  const request = indexedDB.open("eco-chat", 3);

  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("conversations")) {
      const conversations = db.createObjectStore("conversations", { keyPath: "id" });
      conversations.createIndex("by-updated", "updatedAt");
    }
    if (!db.objectStoreNames.contains("messages")) {
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("by-conversation", "conversationId");
      messages.createIndex("by-parent", "parentId");
    }
  };

  request.onsuccess = () => {
    // Created synchronously here: IndexedDB orders transactions by creation
    // time within a scope, so the app's later read cannot start before this
    // write commits. An await anywhere above this line would forfeit that.
    const tx = request.result.transaction(["conversations", "messages"], "readwrite");
    tx.objectStore("conversations").put(seed.conversation);
    const messages = tx.objectStore("messages");
    for (const message of seed.messages) {
      messages.put(message);
    }
  };
}
