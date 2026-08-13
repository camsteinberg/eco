// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Stage-1 retrieval GATE corpus + labeled query set.
 *
 * PURPOSE. This is the labeled evidence for a single go/no-go decision: is an
 * embeddings-based retrieval lever worth building, or does the shipped LEXICAL
 * keyword/coverage gate (apps/web/src/lib/tools/wikipedia-grounding-tool.ts)
 * already rank the right document well enough that embeddings buy nothing? It is
 * NOT a productionizable retrieval index and it is NOT a model-quality judge — it
 * only measures RANKING (which document) and a GATE decision (whether to ground).
 *
 * ── HONEST LABELING RATIONALE (read before trusting a number) ───────────────
 *
 * The whole value of a gate benchmark is in the labels, so the biasing choices
 * are written down here rather than hidden in the wording of the queries.
 *
 * 1. TWO QUESTIONS, KEPT SEPARATE.
 *    - RANKING: for a query that SHOULD retrieve, is the correct document ranked
 *      #1? Measured only over `shouldGround: true` queries (the long-tail subset).
 *    - GATING: should retrieval fire AT ALL for this query? `shouldGround`
 *      encodes the label. A factual long-tail ask a 1-2B model confabulates =>
 *      true. Chit-chat, a pure text transform, a creative/opinion/code ask, OR a
 *      piece of COMMON knowledge the model already answers correctly => false.
 *
 * 2. COMMON-KNOWLEDGE FACTUAL QUERIES ARE LABELED `shouldGround: false` ON
 *    PURPOSE, and their answer documents are DELIBERATELY present in the corpus
 *    (d-france-capital, d-water-boil, d-romeo, d-earth-year, d-speed-light).
 *    This is the honest trap: both arms tend to FIRE on them (the lexical gate
 *    sees a factual cue + entity; a cosine gate sees a high-similarity doc), so
 *    both take a gate false-positive. Neither "should we ground" mechanism can
 *    tell common-knowledge from long-tail by similarity or by cue alone — and the
 *    benchmark should surface that, not paper over it.
 *
 * 3. NO PARAPHRASE TILT. Queries are written the way a real user types (lowercase,
 *    terse, colloquial). The long-tail set is a DELIBERATE MIX:
 *    - LEXICAL-FRIENDLY: the query shares surface tokens with the doc title/body
 *      ("how deep is lake baikal", "when was nintendo founded"). The keyword gate
 *      SHOULD win or tie these; if cosine can't at least match here it is a wash.
 *    - VOCABULARY / MORPHOLOGY MISMATCH: realistic phrasings where the user's word
 *      is a synonym or a different inflection of the doc's word ("what animal poops
 *      cubes" vs "cube-shaped feces"; "most volcanic activity" vs "volcanically
 *      active"; "came up with the idea" vs "proposed"). Embeddings SHOULD win these
 *      — but they are phrasings a real person would actually type, not contrived
 *      to flatter the encoder.
 *    - DISTRACTOR-SENSITIVE: the corpus is built in CLUSTERS (five lakes, five
 *      peaks, five treaties, six scientists, six space missions, five origin-story
 *      companies) so a right answer requires discriminating among near-neighbors,
 *      not matching a globally unique keyword. This is where a naive coverage gate
 *      can rank a sibling doc #1.
 *
 * 4. KNOWN WAYS THIS SET COULD BE UNFAIR (stated so the reader can discount):
 *    - Unfair to LEXICAL: the shipped gate is pure set-coverage with a title
 *      weight — no IDF, no length normalization. A production-grade BM25 lexical
 *      baseline would likely beat it on the mismatch cases. We mirror the SHIPPED
 *      gate faithfully (that is the lever's real competitor), so read "lexical" as
 *      "today's shipped mechanism", not "the best possible lexical retriever".
 *    - Unfair to COSINE: the gate we give it is a bare similarity threshold, which
 *      is a genuinely poor task-type signal — it cannot see that "rewrite this"
 *      is a transform. The lexical arm gets the shipped deny-set for free. So the
 *      GATE comparison partly re-measures the deny-set, and the honest head-to-head
 *      is the RANKING accuracy, not the gate precision. (The report says so.)
 *    - Corpus size is ~60 docs, not thousands. Coverage ties are rarer and cosine's
 *      recall edge on a huge long-tail index is under-sampled here. A Stage-1 gate
 *      is meant to be cheap, so this is accepted — but it caps how decisively a win
 *      can generalize upward.
 *
 * Facts are real and long-tail-but-verifiable (chosen to be the kind a small model
 * confabulates), so a wrong gold label is a labeling bug, not a model call.
 *
 * @typedef {Object} BenchDoc
 * @property {string} id     Stable document id.
 * @property {string} title Short subject line (the "article title" analog).
 * @property {string} text  1-3 sentence factual passage.
 *
 * @typedef {'obscure-factual'|'common-factual'|'chitchat'|'transform'|'creative'|'opinion'|'code'} QueryCategory
 *
 * @typedef {Object} BenchQuery
 * @property {string} id
 * @property {string} text            The user's raw typed query.
 * @property {string|null} correctDocId  The single gold doc for should-retrieve queries; null otherwise.
 * @property {boolean} shouldGround   Ground-truth gate label (true = retrieval should fire).
 * @property {QueryCategory} category
 * @property {string} [note]          Why this query is here / what it stresses.
 */

/** @type {readonly BenchDoc[]} */
export const CORPUS = [
  // ── Cluster: deep / notable lakes (distractors for each other) ────────────
  { id: 'd-lake-baikal', title: 'Lake Baikal', text: "Lake Baikal in Siberia, Russia is the world's deepest lake at about 1,642 metres and the oldest freshwater lake at roughly 25 million years. It holds around a fifth of the planet's unfrozen fresh water." },
  { id: 'd-lake-tanganyika', title: 'Lake Tanganyika', text: 'Lake Tanganyika in East Africa is the second deepest lake in the world at about 1,470 metres and the longest freshwater lake. It is shared by Tanzania, the Democratic Republic of the Congo, Burundi and Zambia.' },
  { id: 'd-lake-titicaca', title: 'Lake Titicaca', text: 'Lake Titicaca, on the border of Peru and Bolivia at about 3,812 metres above sea level, is the highest navigable lake in the world.' },
  { id: 'd-caspian-sea', title: 'Caspian Sea', text: 'Despite its name the Caspian Sea is the largest inland body of water on Earth and the largest lake by surface area. It is endorheic, meaning it has no outflow to an ocean.' },
  { id: 'd-lake-vostok', title: 'Lake Vostok', text: 'Lake Vostok is the largest subglacial lake in Antarctica, sealed beneath roughly four kilometres of ice for millions of years.' },

  // ── Cluster: high mountains (distractors for each other) ──────────────────
  { id: 'd-k2', title: 'K2', text: 'K2, in the Karakoram range on the China-Pakistan border, is the second highest mountain on Earth at 8,611 metres. Its difficulty and death rate earned it the nickname the Savage Mountain.' },
  { id: 'd-kangchenjunga', title: 'Kangchenjunga', text: 'Kangchenjunga, on the border of India and Nepal, is the third highest mountain in the world at 8,586 metres.' },
  { id: 'd-denali', title: 'Denali', text: 'Denali in Alaska is the highest mountain peak in North America at 6,190 metres above sea level.' },
  { id: 'd-aconcagua', title: 'Aconcagua', text: 'Aconcagua in Argentina is the highest mountain in the Americas and the Southern Hemisphere at 6,961 metres.' },
  { id: 'd-elbrus', title: 'Mount Elbrus', text: 'Mount Elbrus, a dormant volcano in the Caucasus of southern Russia, is the highest mountain in Europe at 5,642 metres.' },

  // ── Cluster: historical treaties (distractors for each other) ─────────────
  { id: 'd-treaty-tordesillas', title: 'Treaty of Tordesillas', text: 'The Treaty of Tordesillas of 1494 divided the newly discovered lands outside Europe between Spain and Portugal along a meridian in the Atlantic Ocean.' },
  { id: 'd-treaty-westphalia', title: 'Peace of Westphalia', text: "The Peace of Westphalia of 1648 ended the Thirty Years' War and is often treated as the foundation of the modern system of sovereign states." },
  { id: 'd-treaty-waitangi', title: 'Treaty of Waitangi', text: 'The Treaty of Waitangi of 1840 was an agreement between the British Crown and a large number of Maori chiefs, and is regarded as a founding document of New Zealand.' },
  { id: 'd-treaty-versailles', title: 'Treaty of Versailles', text: 'The Treaty of Versailles of 1919 formally ended the First World War and imposed heavy reparations and territorial losses on Germany.' },
  { id: 'd-treaty-utrecht', title: 'Treaty of Utrecht', text: 'The Treaty of Utrecht of 1713 ended the War of the Spanish Succession and rearranged the balance of power in Europe.' },

  // ── Cluster: scientists and their discoveries (distractors) ───────────────
  { id: 'd-mendel', title: 'Gregor Mendel', text: 'Gregor Mendel was an Augustinian friar whose experiments crossing pea plants in the 1860s established the basic laws of heredity and founded the modern science of genetics.' },
  { id: 'd-semmelweis', title: 'Ignaz Semmelweis', text: 'Ignaz Semmelweis showed in 1847 that requiring doctors to wash their hands sharply reduced deaths from childbed fever in a Vienna maternity clinic.' },
  { id: 'd-mcclintock', title: 'Barbara McClintock', text: 'Barbara McClintock discovered transposons, or jumping genes, in maize, work that won her the Nobel Prize in Physiology or Medicine in 1983.' },
  { id: 'd-fleming', title: 'Alexander Fleming', text: 'Alexander Fleming discovered the antibiotic penicillin in 1928 after noticing that a mould contaminating a culture plate killed the surrounding bacteria.' },
  { id: 'd-wegener', title: 'Alfred Wegener', text: 'Alfred Wegener proposed the theory of continental drift in 1912, arguing that the continents had once formed a single landmass and slowly moved apart.' },
  { id: 'd-lovelace', title: 'Ada Lovelace', text: "Ada Lovelace wrote what is widely considered the first computer program, an algorithm for Charles Babbage's proposed Analytical Engine." },

  // ── Cluster: space missions and bodies (distractors) ──────────────────────
  { id: 'd-voyager1', title: 'Voyager 1', text: 'Voyager 1, launched in 1977, is the most distant human-made object from Earth and crossed into interstellar space in 2012.' },
  { id: 'd-new-horizons', title: 'New Horizons', text: 'The New Horizons spacecraft made the first close flyby of the dwarf planet Pluto in July 2015, returning detailed images of its surface.' },
  { id: 'd-cassini', title: 'Cassini', text: 'The Cassini spacecraft studied Saturn and its moons for thirteen years before deliberately plunging into the planet in 2017.' },
  { id: 'd-ceres', title: 'Ceres', text: 'Ceres is the largest object in the asteroid belt between Mars and Jupiter and is classified as a dwarf planet.' },
  { id: 'd-titan', title: 'Titan', text: "Titan, the largest moon of Saturn, has a thick nitrogen atmosphere and stable surface lakes and seas of liquid methane and ethane." },
  { id: 'd-io', title: 'Io', text: 'Io, one of the large moons of Jupiter, is the most volcanically active body in the Solar System, with hundreds of erupting volcanoes.' },

  // ── Cluster: corporate origin stories (distractors) ───────────────────────
  { id: 'd-nokia', title: 'Nokia', text: 'Nokia was founded in 1865 in Finland as a single paper mill on the banks of the Nokianvirta river, long before it made rubber goods or phones.' },
  { id: 'd-nintendo', title: 'Nintendo', text: 'Nintendo was founded in 1889 in Kyoto, Japan, and originally produced handmade hanafuda playing cards.' },
  { id: 'd-lamborghini', title: 'Lamborghini', text: 'Before it built sports cars, Lamborghini began as a manufacturer of tractors and other agricultural machinery in Italy.' },
  { id: 'd-samsung', title: 'Samsung', text: 'Samsung was founded in 1938 as a small trading company dealing in dried fish, groceries and noodles before moving into electronics decades later.' },
  { id: 'd-3m', title: '3M', text: '3M began in 1902 as the Minnesota Mining and Manufacturing Company, a failed corundum mine that pivoted to making sandpaper.' },

  // ── Assorted long-tail facts (mostly unique keywords) ─────────────────────
  { id: 'd-quinine', title: 'Quinine', text: 'Quinine, extracted from the bark of the cinchona tree, was the first effective treatment for malaria and gives tonic water its bitter taste.' },
  { id: 'd-saffron', title: 'Saffron', text: 'Saffron, harvested from the dried stigmas of the Crocus sativus flower, is the most expensive spice in the world by weight because each flower yields only three threads.' },
  { id: 'd-honey', title: 'Honey preservation', text: 'Honey essentially never spoils; edible pots of honey thousands of years old have been recovered from ancient Egyptian tombs.' },
  { id: 'd-octopus', title: 'Octopus anatomy', text: 'An octopus has three hearts and blue blood, because it carries oxygen using the copper-based protein hemocyanin rather than iron-based hemoglobin.' },
  { id: 'd-shrimp', title: 'Shrimp anatomy', text: 'A shrimp’s heart is located in its head, within the thorax just behind the eyes.' },
  { id: 'd-wombat', title: 'Wombat scat', text: 'Wombats are the only animals known to produce cube-shaped droppings, formed by the varying elasticity of their intestinal walls.' },
  { id: 'd-flamingo', title: 'Flamingo colour', text: 'Flamingos are born grey and turn pink because their diet of algae and brine shrimp is rich in carotenoid pigments.' },
  { id: 'd-cashew', title: 'Cashew', text: 'A cashew grows on the bottom of the cashew apple, and its shell contains a caustic oil related to the one in poison ivy, so cashews are never sold in the shell.' },
  { id: 'd-mantis-shrimp', title: 'Mantis shrimp', text: 'The mantis shrimp strikes with clubs so fast that the water briefly boils, and it has one of the most complex sets of colour receptors of any animal.' },
  { id: 'd-tardigrade', title: 'Tardigrade', text: 'Tardigrades, or water bears, can survive extreme cold, radiation and the vacuum of space by entering a desiccated state called cryptobiosis.' },
  { id: 'd-antikythera', title: 'Antikythera mechanism', text: 'The Antikythera mechanism, recovered from a Roman-era shipwreck, is an ancient Greek geared device used to predict astronomical positions and eclipses.' },
  { id: 'd-bismuth', title: 'Bismuth', text: 'Bismuth forms striking iridescent stair-stepped crystals and is one of the few substances, along with water, that expands as it freezes.' },
  { id: 'd-vantablack', title: 'Vantablack', text: 'Vantablack is a coating of vertical carbon nanotubes that absorbs almost all visible light, making coated objects look like flat black voids.' },
  { id: 'd-esperanto', title: 'Esperanto', text: 'Esperanto is a constructed international auxiliary language created by L. L. Zamenhof in 1887 to be easy to learn as a neutral second language.' },

  // ── Common-knowledge docs (answers to shouldGround:false factual queries) ──
  { id: 'd-france-capital', title: 'Capital of France', text: 'Paris is the capital and most populous city of France.' },
  { id: 'd-water-boil', title: 'Boiling point of water', text: 'At sea-level atmospheric pressure, water boils at 100 degrees Celsius, or 212 degrees Fahrenheit.' },
  { id: 'd-romeo', title: 'Romeo and Juliet', text: 'Romeo and Juliet is a tragedy written by the English playwright William Shakespeare early in his career.' },
  { id: 'd-earth-year', title: 'Length of a year', text: 'The Earth takes about 365.25 days to complete one orbit of the Sun, which is why a leap day is added every four years.' },
  { id: 'd-speed-light', title: 'Speed of light', text: 'The speed of light in a vacuum is about 299,792 kilometres per second.' },
];

/** @type {readonly BenchQuery[]} */
export const QUERIES = [
  // ─────────────── shouldGround: true — long-tail factual ──────────────────
  // Lexical-friendly (query shares surface tokens with the gold doc).
  { id: 'q-baikal-deep', text: 'how deep is lake baikal', correctDocId: 'd-lake-baikal', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly: title tokens lake+baikal present' },
  { id: 'q-baikal-age', text: 'how old is lake baikal', correctDocId: 'd-lake-baikal', shouldGround: true, category: 'obscure-factual', note: 'same doc, different attribute; tanganyika is the deep-lake distractor' },
  { id: 'q-tordesillas', text: 'what was the treaty of tordesillas', correctDocId: 'd-treaty-tordesillas', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly among five treaty distractors' },
  { id: 'q-mcclintock', text: 'what did barbara mcclintock discover', correctDocId: 'd-mcclintock', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly full name' },
  { id: 'q-nintendo-founded', text: 'when was nintendo founded', correctDocId: 'd-nintendo', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly; five origin-story distractors' },
  { id: 'q-k2-tall', text: 'how tall is k2', correctDocId: 'd-k2', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly unique token k2' },
  { id: 'q-semmelweis', text: 'what did semmelweis figure out about handwashing', correctDocId: 'd-semmelweis', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly (semmelweis, handwashing)' },
  { id: 'q-flamingo', text: 'why are flamingos pink', correctDocId: 'd-flamingo', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly (flamingos, pink)' },
  { id: 'q-octopus-hearts', text: 'how many hearts does an octopus have', correctDocId: 'd-octopus', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly (octopus, hearts)' },
  { id: 'q-shrimp-heart', text: "where is a shrimp's heart located", correctDocId: 'd-shrimp', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly (shrimp, heart)' },
  { id: 'q-nokia-start', text: 'what did nokia make when it started', correctDocId: 'd-nokia', shouldGround: true, category: 'obscure-factual', note: 'lexical-friendly token nokia + origin-story distractors' },
  { id: 'q-newhorizons', text: 'which probe flew past pluto', correctDocId: 'd-new-horizons', shouldGround: true, category: 'obscure-factual', note: 'flew past vs flew by; pluto anchors it' },
  { id: 'q-tordesillas-desc', text: 'which treaty divided the new world between spain and portugal', correctDocId: 'd-treaty-tordesillas', shouldGround: true, category: 'obscure-factual', note: 'descriptive; strong overlap but five treaty distractors' },

  // Vocabulary / morphology mismatch (embeddings SHOULD help).
  { id: 'q-second-mountain', text: 'what is the second highest mountain in the world', correctDocId: 'd-k2', shouldGround: true, category: 'obscure-factual', note: 'no k2 token; "highest mountain" also in kangchenjunga (third) — distractor trap' },
  { id: 'q-freshwater', text: 'which lake holds the most fresh water on earth', correctDocId: 'd-lake-baikal', shouldGround: true, category: 'obscure-factual', note: 'paraphrase of "a fifth of unfrozen fresh water"; caspian/titicaca distract' },
  { id: 'q-tractors', text: 'what company started out making tractors', correctDocId: 'd-lamborghini', shouldGround: true, category: 'obscure-factual', note: 'no lamborghini token; tractor is the lexical anchor' },
  { id: 'q-farthest-probe', text: 'which spacecraft is the farthest from earth', correctDocId: 'd-voyager1', shouldGround: true, category: 'obscure-factual', note: 'space-mission cluster; farthest/distant near-synonyms' },
  { id: 'q-methane-moon', text: 'what moon has lakes of liquid methane', correctDocId: 'd-titan', shouldGround: true, category: 'obscure-factual', note: 'strong overlap but io/ceres distract' },
  { id: 'q-volcanic-moon', text: 'which body in the solar system has the most volcanic activity', correctDocId: 'd-io', shouldGround: true, category: 'obscure-factual', note: 'MORPHOLOGY: "volcanic activity" vs doc "volcanically active" — different tokens' },
  { id: 'q-expensive-spice', text: 'what is the most expensive spice', correctDocId: 'd-saffron', shouldGround: true, category: 'obscure-factual', note: 'no saffron token; "most expensive spice" is in the body' },
  { id: 'q-westphalia', text: 'which peace agreement ended the thirty years war', correctDocId: 'd-treaty-westphalia', shouldGround: true, category: 'obscure-factual', note: '"peace agreement" vs "Peace of Westphalia"; thirty years war anchors' },
  { id: 'q-continental-drift', text: 'who came up with the idea of continental drift', correctDocId: 'd-wegener', shouldGround: true, category: 'obscure-factual', note: 'verb paraphrase (came up with vs proposed); continental drift anchors' },
  { id: 'q-europe-peak', text: 'which mountain is the highest in europe', correctDocId: 'd-elbrus', shouldGround: true, category: 'obscure-factual', note: 'no elbrus token; peak cluster distractors' },
  { id: 'q-first-program', text: 'who wrote the first computer program', correctDocId: 'd-lovelace', shouldGround: true, category: 'obscure-factual', note: '"program" vs doc "algorithm/program"; lovelace not named in query' },
  { id: 'q-largest-lake', text: 'which sea is actually the largest lake in the world', correctDocId: 'd-caspian-sea', shouldGround: true, category: 'obscure-factual', note: 'sea/lake tension; lake-cluster distractors' },
  { id: 'q-cube-poop', text: 'what animal poops cubes', correctDocId: 'd-wombat', shouldGround: true, category: 'obscure-factual', note: 'STRONG mismatch: "poops cubes" vs "cube-shaped droppings" — cosine should win' },
  { id: 'q-penicillin', text: 'who discovered penicillin', correctDocId: 'd-fleming', shouldGround: true, category: 'obscure-factual', note: 'fleming not in query; penicillin is body-only token — tests body coverage' },
  { id: 'q-jumping-genes', text: 'who found out that genes can jump around in corn', correctDocId: 'd-mcclintock', shouldGround: true, category: 'obscure-factual', note: 'MISMATCH: "corn" vs "maize", "jump around" vs "jumping genes/transposons" — cosine should win' },

  // ─────────────── shouldGround: false — common knowledge (doc EXISTS) ──────
  { id: 'q-france', text: "what's the capital of france", correctDocId: 'd-france-capital', shouldGround: false, category: 'common-factual', note: 'HONEST TRAP: doc exists + factual cue, but model knows it — both gates likely mis-fire' },
  { id: 'q-romeo', text: 'who wrote romeo and juliet', correctDocId: 'd-romeo', shouldGround: false, category: 'common-factual', note: 'common knowledge; gate false-positive risk for both arms' },
  { id: 'q-water-boil', text: 'at what temperature does water boil', correctDocId: 'd-water-boil', shouldGround: false, category: 'common-factual', note: 'common knowledge' },
  { id: 'q-year-days', text: 'how many days are in a year', correctDocId: 'd-earth-year', shouldGround: false, category: 'common-factual', note: 'common knowledge' },
  { id: 'q-lightspeed', text: 'how fast does light travel', correctDocId: 'd-speed-light', shouldGround: false, category: 'common-factual', note: 'common knowledge; paraphrase of the doc too' },

  // ─────────────── shouldGround: false — chit-chat / social ─────────────────
  { id: 'q-hello', text: 'hello', correctDocId: null, shouldGround: false, category: 'chitchat' },
  { id: 'q-hows-it-going', text: "hey how's it going", correctDocId: null, shouldGround: false, category: 'chitchat' },
  { id: 'q-thanks', text: 'thanks so much for your help', correctDocId: null, shouldGround: false, category: 'chitchat' },
  { id: 'q-stressed', text: "i'm feeling a bit stressed today", correctDocId: null, shouldGround: false, category: 'chitchat', note: 'emotional small talk, not a fact lookup' },

  // ─────────────── shouldGround: false — transforms on user's own text ──────
  { id: 'q-rewrite', text: 'rewrite this paragraph to sound more friendly', correctDocId: null, shouldGround: false, category: 'transform', note: 'deny-set: rewrite' },
  { id: 'q-summarize', text: 'summarize the following text in one sentence', correctDocId: null, shouldGround: false, category: 'transform', note: 'no factual cue / no entity — lexical declines by cue, not deny' },
  { id: 'q-fix-grammar', text: 'fix the grammar in this sentence for me', correctDocId: null, shouldGround: false, category: 'transform', note: 'deny-set: fix + grammar' },
  { id: 'q-proofread', text: 'proofread my email below', correctDocId: null, shouldGround: false, category: 'transform', note: 'deny-set: proofread' },
  { id: 'q-translate', text: 'translate good morning into spanish', correctDocId: null, shouldGround: false, category: 'transform', note: 'deny-set: translate/in spanish' },

  // ─────────────── shouldGround: false — creative ──────────────────────────
  { id: 'q-poem', text: 'write me a short poem about the ocean', correctDocId: null, shouldGround: false, category: 'creative', note: 'deny-set: write/poem' },
  { id: 'q-story', text: 'make up a story about a dragon', correctDocId: null, shouldGround: false, category: 'creative', note: 'deny-set: make up/story' },

  // ─────────────── shouldGround: false — opinion / advice ──────────────────
  { id: 'q-learn-lang', text: 'should i learn python or javascript first', correctDocId: null, shouldGround: false, category: 'opinion', note: 'deny-set: should i / python / javascript' },
  { id: 'q-best-city', text: "what's the best city to live in", correctDocId: null, shouldGround: false, category: 'opinion', note: 'deny-set: best city' },
  { id: 'q-remote-work', text: 'do you think remote work is better', correctDocId: null, shouldGround: false, category: 'opinion', note: 'deny-set: do you think' },

  // ─────────────── shouldGround: false — code ──────────────────────────────
  { id: 'q-reverse-fn', text: 'write a function to reverse a string in javascript', correctDocId: null, shouldGround: false, category: 'code', note: 'deny-set: function/javascript' },
  { id: 'q-center-div', text: 'how do i center a div with css', correctDocId: null, shouldGround: false, category: 'code', note: 'HONEST: css is NOT in the shipped deny-set, so the lexical gate likely mis-fires here; cosine should decline on low similarity' },
];
